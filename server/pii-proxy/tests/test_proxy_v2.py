"""Integration tests for the v2 PII proxy (issue #24 regression suite)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import pii_proxy
from pii_detect import Detector, DetectorConfig
from pii_vault import Vault


SECRET_PASSWORD = 'pa"ss\\word-1234'  # quotes, backslash: the D1 trigger
SECRET_EMAIL = "alice@example.com"


@pytest.fixture()
def proxy(tmp_path, monkeypatch):
    """Fresh vault + detector per test, installed on the module globals."""
    vault = Vault(tmp_path / "vault.json", secret=b"0" * 32)
    cfg = DetectorConfig(
        literals=[("PASSWORD", SECRET_PASSWORD)],
        patterns=list(pii_proxy.BUILTIN_PATTERNS),
    )
    detector = Detector(cfg)
    monkeypatch.setattr(pii_proxy, "VAULT", vault)
    monkeypatch.setattr(pii_proxy, "DETECTOR", detector)
    pii_proxy._log_buffer.clear()
    pii_proxy._pii_groups.clear()
    return pii_proxy


def _mock_upstream(response_body: bytes, content_type: str = "application/json", sse_chunks=None):
    """Return an async send() replacement capturing the forwarded request body."""
    captured = {}

    class _Resp:
        status_code = 200
        headers = {"content-type": content_type}

        def __init__(self, chunks):
            self._chunks = chunks

        async def aiter_bytes(self):
            for chunk in self._chunks:
                yield chunk

        async def aread(self):
            return None

        @property
        def content(self):
            return response_body

        async def aclose(self):
            return None

    async def _send(request, stream=False):
        captured["body"] = request.content
        return _Resp(sse_chunks if sse_chunks is not None else [response_body])

    return _send, captured


def _sse(*events: dict) -> bytes:
    return b"".join(b"data: " + json.dumps(e).encode() + b"\n\n" for e in events)


def test_request_anonymizes_literal_and_keyword(proxy, monkeypatch):
    send, captured = _mock_upstream(b'{"content": []}')
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        resp = client.post("/v1/messages", json={"messages": [
            {"role": "user", "content": "password=" + SECRET_PASSWORD + " and mail " + SECRET_EMAIL},
        ]})
    assert resp.status_code == 200
    forwarded = captured["body"].decode()
    assert SECRET_PASSWORD not in forwarded
    assert SECRET_EMAIL not in forwarded
    assert "PII_PASSWORD_" in forwarded and "PII_EMAIL_ADDRESS_" in forwarded


def test_nested_tool_use_and_system_list_are_covered(proxy, monkeypatch):
    send, captured = _mock_upstream(b'{"content": []}')
    monkeypatch.setattr(pii_proxy._client, "send", send)
    payload = {
        "system": [{"type": "text", "text": "user " + SECRET_EMAIL}],
        "messages": [{"role": "assistant", "content": [
            {"type": "tool_use", "id": "t1", "name": "write_file",
             "input": {"path": "/tmp/x", "meta": {"nested": ["deep " + SECRET_EMAIL]}}},
        ]}],
    }
    with TestClient(pii_proxy.app) as client:
        assert client.post("/v1/messages", json=payload).status_code == 200
    forwarded = captured["body"].decode()
    assert SECRET_EMAIL not in forwarded
    assert forwarded.count("PII_EMAIL_ADDRESS_") >= 2


def test_tool_result_is_covered(proxy, monkeypatch):
    send, captured = _mock_upstream(b'{"content": []}')
    monkeypatch.setattr(pii_proxy._client, "send", send)
    payload = {"messages": [{"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "env: " + SECRET_PASSWORD},
    ]}]}
    with TestClient(pii_proxy.app) as client:
        assert client.post("/v1/messages", json=payload).status_code == 200
    assert SECRET_PASSWORD not in captured["body"].decode()


def test_signed_thinking_block_is_never_rewritten(proxy, monkeypatch):
    send, captured = _mock_upstream(b'{"content": []}')
    monkeypatch.setattr(pii_proxy._client, "send", send)
    payload = {"messages": [{"role": "assistant", "content": [
        {"type": "thinking", "thinking": "the password is " + SECRET_PASSWORD, "signature": "SIG=="},
        {"type": "text", "text": "contact " + SECRET_EMAIL},
    ]}]}
    with TestClient(pii_proxy.app) as client:
        assert client.post("/v1/messages", json=payload).status_code == 200
    forwarded = json.loads(captured["body"])
    thinking = forwarded["messages"][0]["content"][0]
    assert thinking["thinking"] == "the password is " + SECRET_PASSWORD  # byte-identical
    assert thinking["signature"] == "SIG=="
    assert SECRET_EMAIL not in json.dumps(forwarded["messages"][0]["content"][1])


def test_json_response_is_restored(proxy, monkeypatch):
    alias = proxy.VAULT.alias_for("EMAIL_ADDRESS", SECRET_EMAIL)
    body = json.dumps({"content": [{"type": "text", "text": "mail " + alias}]}).encode()
    send, _ = _mock_upstream(body)
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        resp = client.post("/v1/messages", json={"messages": []})
    assert SECRET_EMAIL in resp.text and alias not in resp.text


def test_response_thinking_stays_untouched(proxy, monkeypatch):
    alias = proxy.VAULT.alias_for("EMAIL_ADDRESS", SECRET_EMAIL)
    body = json.dumps({"content": [
        {"type": "thinking", "thinking": "saw " + alias, "signature": "SIG=="},
    ]}).encode()
    send, _ = _mock_upstream(body)
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        resp = client.post("/v1/messages", json={"messages": []})
    out = json.loads(resp.text)
    assert out["content"][0]["thinking"] == "saw " + alias  # signed block untouched
    assert out["content"][0]["signature"] == "SIG=="


def test_sse_is_restored_and_stays_valid_json(proxy, monkeypatch):
    """D1 + D2 regression: quote-bearing secret, placeholder split across chunks."""
    alias = proxy.VAULT.alias_for("PASSWORD", SECRET_PASSWORD)
    text = "here it is: " + alias + " done"
    event = {"type": "content_block_delta", "index": 0,
             "delta": {"type": "text_delta", "text": text}}
    raw = _sse(event)
    cut = raw.index(b"PII_") + 2  # split inside the placeholder prefix
    chunks = [raw[:cut], raw[cut:]]
    send, _ = _mock_upstream(b"", "text/event-stream", sse_chunks=chunks)
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        resp = client.post("/v1/messages", json={"messages": []})
    frames = [line for line in resp.text.split("\n") if line.startswith("data: ")]
    assert frames, "expected SSE frames"
    parsed = [json.loads(f[6:]) for f in frames]
    assert "".join(p["delta"]["text"] for p in parsed if p.get("delta", {}).get("text")) == "here it is: " + SECRET_PASSWORD + " done"
    assert alias not in resp.text


def test_count_tokens_path_is_anonymized(proxy, monkeypatch):
    send, captured = _mock_upstream(b'{"input_tokens": 1}')
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        assert client.post("/v1/messages/count_tokens", json={"messages": [{"role": "user", "content": SECRET_PASSWORD}]}).status_code == 200
    assert SECRET_PASSWORD not in captured["body"].decode()


def test_fail_open_on_unparsable_body(proxy, monkeypatch):
    send, captured = _mock_upstream(b'{"ok": true}')
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        resp = client.post("/v1/messages", content=b"not json at all")
    assert resp.status_code == 200
    assert captured["body"] == b"not json at all"


def test_vault_alias_is_deterministic_across_instances(tmp_path):
    path = tmp_path / "vault.json"
    first = Vault(path, secret=b"1" * 32)
    alias = first.alias_for("EMAIL_ADDRESS", SECRET_EMAIL)
    first.save()
    second = Vault(path)
    assert second.alias_for("EMAIL_ADDRESS", SECRET_EMAIL) == alias
    assert second.restore_text("mail " + alias) == "mail " + SECRET_EMAIL


def test_health_exposes_detector_and_vault(proxy):
    with TestClient(pii_proxy.app) as client:
        body = client.get("/health").json()
    assert body["status"] == "ok" and body["mode"] == "v2-aliases"
    assert "detector" in body and "vault" in body
