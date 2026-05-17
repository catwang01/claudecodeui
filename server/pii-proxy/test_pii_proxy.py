import json
import os
import sys
from dataclasses import dataclass
from unittest.mock import MagicMock

# 設置測試用固定 AES 密钥（32 bytes = 64 hex chars）
os.environ["PII_PROXY_AES_KEY"] = "a" * 64
os.environ["PII_PROXY_UPSTREAM_URL"] = "http://test-upstream"

# Mock presidio_analyzer BEFORE importing pii_proxy to avoid spacy model download at module init
@dataclass
class _RecognizerResult:
    entity_type: str
    start: int
    end: int
    score: float

_mock_presidio = MagicMock()
_mock_analyzer_instance = MagicMock()
_mock_analyzer_instance.analyze.return_value = []
_mock_presidio.AnalyzerEngine.return_value = _mock_analyzer_instance
_mock_presidio.RecognizerResult = _RecognizerResult
sys.modules["presidio_analyzer"] = _mock_presidio
sys.modules["presidio_analyzer.nlp_engine"] = MagicMock()

import pytest
from fastapi.testclient import TestClient

from pii_proxy import app, anonymize_text, deanonymize_text, _encrypt, _decrypt, _client

client = TestClient(app)


# ---------------------------------------------------------------------------
# Unit: AES helpers
# ---------------------------------------------------------------------------

def test_encrypt_decrypt_roundtrip():
    original = "John Doe"
    encrypted = _encrypt(original)
    assert encrypted != original
    assert _decrypt(encrypted) == original


def test_encrypt_deterministic():
    # 相同明文每次产生相同密文（确定性加密）
    assert _encrypt("same text") == _encrypt("same text")
    # 不同明文产生不同密文
    assert _encrypt("text A") != _encrypt("text B")


# ---------------------------------------------------------------------------
# Unit: anonymize / deanonymize text
# ---------------------------------------------------------------------------

def test_deanonymize_no_tags_returns_unchanged():
    text = "Hello world, no PII here."
    assert deanonymize_text(text) == text


def test_anonymize_deanonymize_roundtrip(monkeypatch):
    from pii_proxy import _analyzer, anonymize_text as _anon

    _s = "My password is s3cr3tVal!"
    _start = _s.index("s3cr3tVal")
    _end = _start + len("s3cr3tVal")

    _anon.cache_clear()
    monkeypatch.setattr(
        _analyzer,
        "analyze",
        lambda text, language, entities: [
            _RecognizerResult(entity_type="PASSWORD", start=_start, end=_end, score=0.85)
        ] if "s3cr3tVal" in text else [],
    )

    original = _s
    anonymized = anonymize_text(original)

    assert "s3cr3tVal" not in anonymized
    assert "<PII:PASSWORD>" in anonymized

    restored = deanonymize_text(anonymized)
    assert restored == original


def test_anonymize_empty_string():
    assert anonymize_text("") == ""
    assert anonymize_text("   ") == "   "


# ---------------------------------------------------------------------------
# Integration: FastAPI endpoints
# ---------------------------------------------------------------------------

def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_proxy_anonymizes_messages_before_forwarding(monkeypatch):
    import pii_proxy

    captured = {}

    async def mock_send(req, stream=False):
        captured["body"] = json.loads(req.content)
        mock_resp = MagicMock()
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.status_code = 200
        mock_resp.content = json.dumps({"content": [{"type": "text", "text": "OK"}]}).encode()
        async def aread(): pass
        mock_resp.aread = aread
        async def aclose(): pass
        mock_resp.aclose = aclose
        return mock_resp

    pii_proxy.anonymize_text.cache_clear()
    monkeypatch.setattr(pii_proxy._client, "send", mock_send)
    monkeypatch.setattr(
        pii_proxy._analyzer,
        "analyze",
        lambda text, language, entities: [
            _RecognizerResult(
                entity_type="PASSWORD",
                start=text.index("hunter2"),
                end=text.index("hunter2") + 7,
                score=0.9,
            )
        ] if "hunter2" in text else [],
    )

    resp = client.post(
        "/v1/messages",
        json={"messages": [{"role": "user", "content": "my password is hunter2"}]},
        headers={"x-api-key": "test-key"},
    )

    assert resp.status_code == 200
    sent_content = captured["body"]["messages"][0]["content"]
    assert "hunter2" not in sent_content
    assert "<PII:PASSWORD>" in sent_content


def test_proxy_deanonymizes_json_response(monkeypatch):
    import pii_proxy

    encrypted_name = pii_proxy._encrypt("Bob")
    fake_response_text = f"Hello <PII:PERSON>{encrypted_name}</PII>!"

    async def mock_send(req, stream=False):
        mock_resp = MagicMock()
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.status_code = 200
        mock_resp.content = json.dumps(
            {"content": [{"type": "text", "text": fake_response_text}]}
        ).encode()
        async def aread(): pass
        mock_resp.aread = aread
        async def aclose(): pass
        mock_resp.aclose = aclose
        return mock_resp

    monkeypatch.setattr(pii_proxy._client, "send", mock_send)
    monkeypatch.setattr(pii_proxy._analyzer, "analyze", lambda *a, **kw: [])

    resp = client.post(
        "/v1/messages",
        json={"messages": [{"role": "user", "content": "hello"}]},
        headers={"x-api-key": "test-key"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["content"][0]["text"] == "Hello Bob!"


# ---------------------------------------------------------------------------
# Integration: SSE passthrough
# ---------------------------------------------------------------------------

def test_proxy_passes_through_sse(monkeypatch):
    """SSE 无 PII tag 时原样透传。"""
    import pii_proxy

    async def mock_send(req, stream=False):
        mock_resp = MagicMock()
        mock_resp.headers = {"content-type": "text/event-stream"}
        mock_resp.status_code = 200

        async def aiter_bytes():
            yield b"data: {}\n\n"

        mock_resp.aiter_bytes = aiter_bytes

        async def aclose():
            pass

        mock_resp.aclose = aclose
        return mock_resp

    monkeypatch.setattr(pii_proxy._client, "send", mock_send)
    monkeypatch.setattr(pii_proxy._analyzer, "analyze", lambda *a, **kw: [])

    with client.stream("POST", "/v1/messages", json={"messages": []}, headers={"x-api-key": "k"}) as resp:
        assert resp.status_code == 200
        chunks = list(resp.iter_bytes())
        assert b"data: {}" in b"".join(chunks)


def test_proxy_sse_deanonymizes_complete_tag_in_single_chunk(monkeypatch):
    """SSE 单个 chunk 内包含完整 PII tag，应被解密还原。"""
    import pii_proxy

    encrypted = pii_proxy._encrypt("Alice")
    tag = f"<PII:PERSON>{encrypted}</PII>".encode()

    async def mock_send(req, stream=False):
        mock_resp = MagicMock()
        mock_resp.headers = {"content-type": "text/event-stream"}
        mock_resp.status_code = 200

        async def aiter_bytes():
            yield b"data: Hello " + tag + b"\n\n"

        mock_resp.aiter_bytes = aiter_bytes
        async def aclose(): pass
        mock_resp.aclose = aclose
        return mock_resp

    monkeypatch.setattr(pii_proxy._client, "send", mock_send)
    monkeypatch.setattr(pii_proxy._analyzer, "analyze", lambda *a, **kw: [])

    with client.stream("POST", "/v1/messages", json={"messages": []}, headers={"x-api-key": "k"}) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes())
        assert b"Alice" in body
        assert b"<PII:PERSON>" not in body


def test_proxy_sse_deanonymizes_tag_split_across_chunks(monkeypatch):
    """SSE tag 被切成两段跨 chunk，仍能正确缓冲后解密还原。"""
    import pii_proxy

    encrypted = pii_proxy._encrypt("Bob")
    full_tag = f"<PII:PERSON>{encrypted}</PII>"
    # 在 <PII: 之后切断，模拟跨 chunk 情况
    split_at = full_tag.index(":") + 3
    chunk1 = ("data: Hello " + full_tag[:split_at]).encode()
    chunk2 = (full_tag[split_at:] + "\n\n").encode()

    async def mock_send(req, stream=False):
        mock_resp = MagicMock()
        mock_resp.headers = {"content-type": "text/event-stream"}
        mock_resp.status_code = 200

        async def aiter_bytes():
            yield chunk1
            yield chunk2

        mock_resp.aiter_bytes = aiter_bytes
        async def aclose(): pass
        mock_resp.aclose = aclose
        return mock_resp

    monkeypatch.setattr(pii_proxy._client, "send", mock_send)
    monkeypatch.setattr(pii_proxy._analyzer, "analyze", lambda *a, **kw: [])

    with client.stream("POST", "/v1/messages", json={"messages": []}, headers={"x-api-key": "k"}) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes())
        assert b"Bob" in body
        assert b"<PII:PERSON>" not in body


def test_proxy_sse_deanonymizes_multiple_tags(monkeypatch):
    """SSE 单次流中包含多个 PII tag，全部解密还原。"""
    import pii_proxy

    enc1 = pii_proxy._encrypt("Carol")
    enc2 = pii_proxy._encrypt("Dave")
    line = f"data: <PII:PERSON>{enc1}</PII> and <PII:PERSON>{enc2}</PII>\n\n".encode()

    async def mock_send(req, stream=False):
        mock_resp = MagicMock()
        mock_resp.headers = {"content-type": "text/event-stream"}
        mock_resp.status_code = 200

        async def aiter_bytes():
            yield line

        mock_resp.aiter_bytes = aiter_bytes
        async def aclose(): pass
        mock_resp.aclose = aclose
        return mock_resp

    monkeypatch.setattr(pii_proxy._client, "send", mock_send)
    monkeypatch.setattr(pii_proxy._analyzer, "analyze", lambda *a, **kw: [])

    with client.stream("POST", "/v1/messages", json={"messages": []}, headers={"x-api-key": "k"}) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes())
        assert b"Carol" in body
        assert b"Dave" in body
        assert b"<PII:PERSON>" not in body


# ---------------------------------------------------------------------------
# Integration: list content anonymization
# ---------------------------------------------------------------------------

def test_proxy_anonymizes_list_content(monkeypatch):
    """messages 中 content 为 list 格式时，text block 也应被脱敏。"""
    import pii_proxy

    captured = {}

    async def mock_send(req, stream=False):
        captured["body"] = json.loads(req.content)
        mock_resp = MagicMock()
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.status_code = 200
        mock_resp.content = json.dumps({"content": []}).encode()

        async def aread():
            pass

        mock_resp.aread = aread

        async def aclose():
            pass

        mock_resp.aclose = aclose
        return mock_resp

    pii_proxy.anonymize_text.cache_clear()
    monkeypatch.setattr(pii_proxy._client, "send", mock_send)
    monkeypatch.setattr(
        pii_proxy._analyzer,
        "analyze",
        lambda text, language, entities: [
            _RecognizerResult(
                entity_type="PASSWORD",
                start=text.index("s3cr3t!"),
                end=text.index("s3cr3t!") + len("s3cr3t!"),
                score=0.95,
            )
        ] if "s3cr3t!" in text else [],
    )

    resp = client.post(
        "/v1/messages",
        json={"messages": [{"role": "user", "content": [
            {"type": "text", "text": "My password is s3cr3t!"},
            {"type": "image_url", "url": "http://example.com/img.png"},
        ]}]},
        headers={"x-api-key": "test-key"},
    )

    assert resp.status_code == 200
    sent_block = captured["body"]["messages"][0]["content"][0]
    assert "s3cr3t!" not in sent_block["text"]
    assert "<PII:PASSWORD>" in sent_block["text"]
    # image block 未被修改
    assert captured["body"]["messages"][0]["content"][1]["url"] == "http://example.com/img.png"

