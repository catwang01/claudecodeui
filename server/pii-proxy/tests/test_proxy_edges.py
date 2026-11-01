"""Edge-case / API-shape tests for pii_proxy (issue #24 hardening)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import pii_proxy
from pii_detect import Detector, DetectorConfig
from pii_vault import Vault

SECRET = "topsecret-pw-1234"


@pytest.fixture()
def proxy(tmp_path, monkeypatch):
    vault = Vault(tmp_path / "vault.json", secret=b"e" * 32)
    detector = Detector(DetectorConfig(
        literals=[("PASSWORD", SECRET)],
        patterns=list(pii_proxy.BUILTIN_PATTERNS),
    ))
    monkeypatch.setattr(pii_proxy, "VAULT", vault)
    monkeypatch.setattr(pii_proxy, "DETECTOR", detector)
    pii_proxy._log_buffer.clear()
    pii_proxy._pii_groups.clear()
    for key in pii_proxy._stats:
        pii_proxy._stats[key] = 0
    return pii_proxy


def _mock_upstream(body: bytes = b'{"content": []}', content_type: str = "application/json", status: int = 200):
    captured: dict = {}

    class _Resp:
        def __init__(self) -> None:
            self.status_code = status
            self.headers = {"content-type": content_type}

        async def aiter_bytes(self):
            yield body

        async def aread(self):
            return None

        @property
        def content(self):
            return body

        async def aclose(self):
            return None

    async def _send(request, stream=False):
        captured["body"] = request.content
        captured["headers"] = dict(request.headers)
        return _Resp()

    return _send, captured


def test_endpoints_keep_ui_compatible_shapes(proxy, monkeypatch):
    send, _ = _mock_upstream()
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        assert client.post("/v1/messages", json={"messages": [{"role": "user", "content": "pw=" + SECRET}]}).status_code == 200
        logs = client.get("/logs").json()
        assert logs["entries"] and "diff" in logs["entries"][0] and "label" in logs["entries"][0]
        groups = client.get("/pii-groups").json()["groups"]
        assert groups and set(groups[0]) >= {"token_key", "entity_type", "masked", "count", "last_seen", "occurrences"}
        assert groups[0]["masked"] and groups[0]["count"] >= 1
        assert client.delete("/pii-groups").json() == {"ok": True}
        assert client.get("/pii-groups").json()["groups"] == []
        assert client.delete("/logs").json() == {"ok": True}
        assert client.get("/logs").json()["entries"] == []


def test_stats_count_signed_blocks_and_binary_payloads(proxy, monkeypatch):
    send, captured = _mock_upstream()
    monkeypatch.setattr(pii_proxy._client, "send", send)
    payload = {
        "messages": [{"role": "assistant", "content": [
            {"type": "thinking", "thinking": "pw=" + SECRET, "signature": "SIG=="},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "A" * 400}},
            {"type": "text", "text": "pw=" + SECRET},
        ]}],
    }
    with TestClient(pii_proxy.app) as client:
        assert client.post("/v1/messages", json=payload).status_code == 200
    assert pii_proxy._stats["signed_blocks_skipped"] >= 1
    assert pii_proxy._stats["uncovered_binary"] == 1
    assert pii_proxy._stats["anonymized_values"] >= 1
    forwarded = json.loads(captured["body"])
    assert forwarded["messages"][0]["content"][0]["thinking"] == "pw=" + SECRET


def test_non_messages_path_is_not_touched(proxy, monkeypatch):
    send, captured = _mock_upstream(b'{"ok": true}')
    monkeypatch.setattr(pii_proxy._client, "send", send)
    body = {"messages": [{"role": "user", "content": SECRET}]}
    with TestClient(pii_proxy.app) as client:
        resp = client.post("/v1/complete", json=body)
    assert resp.status_code == 200
    assert json.loads(captured["body"]) == body  # untouched on non-messages paths


def test_binary_and_plain_content_types_pass_through(proxy, monkeypatch):
    send, _ = _mock_upstream(b"raw bytes with PII_PASSWORD_abcdef inside", "text/plain")
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        resp = client.post("/v1/messages", json={"messages": []})
    assert resp.status_code == 200 and resp.text == "raw bytes with PII_PASSWORD_abcdef inside"


def test_json_error_response_is_restored_and_status_kept(proxy, monkeypatch):
    alias = proxy.VAULT.alias_for("PASSWORD", SECRET)
    send, _ = _mock_upstream(json.dumps({"error": {"message": "bad pw " + alias}}).encode(), "application/json", status=429)
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        resp = client.post("/v1/messages", json={"messages": []})
    assert resp.status_code == 429
    assert SECRET in resp.text and alias not in resp.text


def test_aliases_are_stable_across_requests(proxy, monkeypatch):
    send, captured = _mock_upstream()
    monkeypatch.setattr(pii_proxy._client, "send", send)
    seen = set()
    with TestClient(pii_proxy.app) as client:
        for _ in range(3):
            assert client.post("/v1/messages", json={"messages": [{"role": "user", "content": "pw=" + SECRET}]}).status_code == 200
            seen.add(captured["body"].decode())
    assert len(seen) == 1  # byte-identical forwarded bodies -> stable alias


def test_missing_or_empty_payload_is_forwarded(proxy, monkeypatch):
    send, captured = _mock_upstream()
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        assert client.post("/v1/messages", json={}).status_code == 200
        assert json.loads(captured["body"]) == {}
        assert client.post("/v1/messages", content=b"").status_code == 200
        assert captured["body"] == b""


def test_metadata_user_id_is_covered(proxy, monkeypatch):
    send, captured = _mock_upstream()
    monkeypatch.setattr(pii_proxy._client, "send", send)
    payload = {"messages": [], "metadata": {"user_id": "pw=" + SECRET}}
    with TestClient(pii_proxy.app) as client:
        assert client.post("/v1/messages", json=payload).status_code == 200
    assert SECRET not in captured["body"].decode()


def test_restore_json_payload_ignores_invalid_json(proxy):
    assert proxy.restore_json_payload(b"not json", "req") == b"not json"


def test_load_detector_merges_user_literals_and_reports_issues(proxy, tmp_path, monkeypatch):
    secrets = tmp_path / "secrets.json"
    secrets.write_text(json.dumps({
        "literals": [{"kind": "PASSWORD", "value": SECRET}, {"kind": "SHORT", "value": "ab"}],
        "patterns": [{"kind": "EMP", "regex": "EMP-[0-9]{4}", "max_len": 12}],
    }), encoding="utf-8")
    monkeypatch.setattr(pii_proxy, "SECRETS_FILE", str(secrets))
    detector = pii_proxy.load_detector()
    kinds = {spec.kind for spec, *_ in detector._patterns}
    assert "EMP" in kinds and "EMAIL_ADDRESS" in kinds  # user pattern + builtins merged
    assert any("shorter than min_literal_len" in issue for issue in detector.issues)
    assert detector.scan("EMP-1234 " + SECRET) != []


def test_sse_done_and_message_stop_pass_through(proxy, monkeypatch):
    raw = (b'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'
           b'data: {"type":"message_stop"}\n\n'
           b'data: [DONE]\n\n')
    send, _ = _mock_upstream(raw, "text/event-stream")
    monkeypatch.setattr(pii_proxy._client, "send", send)
    with TestClient(pii_proxy.app) as client:
        resp = client.post("/v1/messages", json={"messages": []})
    assert resp.text.count("message_stop") == 1 and "[DONE]" in resp.text
    for line in resp.text.split("\n"):
        if line.startswith("data: ") and line[6:] != "[DONE]":
            json.loads(line[6:])
