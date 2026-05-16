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
    from pii_proxy import _analyzer

    _s = "Hello, my name is John Doe!"
    _start = _s.index("John Doe")
    _end = _start + len("John Doe")

    monkeypatch.setattr(
        _analyzer,
        "analyze",
        lambda text, language, entities: [
            _RecognizerResult(entity_type="PERSON", start=_start, end=_end, score=0.85)
        ] if "John Doe" in text else [],
    )

    original = _s
    anonymized = anonymize_text(original)

    assert "John Doe" not in anonymized
    assert "<PII:PERSON>" in anonymized

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

    monkeypatch.setattr(pii_proxy._client, "send", mock_send)
    monkeypatch.setattr(
        pii_proxy._analyzer,
        "analyze",
        lambda text, language, entities: [
            _RecognizerResult(
                entity_type="PERSON",
                start=text.index("Jane"),
                end=text.index("Jane") + 4,
                score=0.9,
            )
        ] if "Jane" in text else [],
    )

    resp = client.post(
        "/v1/messages",
        json={"messages": [{"role": "user", "content": "Hi, I am Jane."}]},
        headers={"x-api-key": "test-key"},
    )

    assert resp.status_code == 200
    sent_content = captured["body"]["messages"][0]["content"]
    assert "Jane" not in sent_content
    assert "<PII:PERSON>" in sent_content


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
    """SSE 响应直接透传，不做任何处理。"""
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

    monkeypatch.setattr(pii_proxy._client, "send", mock_send)
    monkeypatch.setattr(
        pii_proxy._analyzer,
        "analyze",
        lambda text, language, entities: [
            _RecognizerResult(
                entity_type="EMAIL_ADDRESS",
                start=text.index("alice@example.com"),
                end=text.index("alice@example.com") + len("alice@example.com"),
                score=0.95,
            )
        ] if "alice@example.com" in text else [],
    )

    resp = client.post(
        "/v1/messages",
        json={"messages": [{"role": "user", "content": [
            {"type": "text", "text": "My email is alice@example.com"},
            {"type": "image_url", "url": "http://example.com/img.png"},
        ]}]},
        headers={"x-api-key": "test-key"},
    )

    assert resp.status_code == 200
    sent_block = captured["body"]["messages"][0]["content"][0]
    assert "alice@example.com" not in sent_block["text"]
    assert "<PII:EMAIL_ADDRESS>" in sent_block["text"]
    # image block 未被修改
    assert captured["body"]["messages"][0]["content"][1]["url"] == "http://example.com/img.png"

