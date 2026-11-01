"""Read-only config view + dry-run endpoints (issue: users cannot see their config)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import pii_proxy
from pii_detect import Detector, DetectorConfig
from pii_vault import Vault


@pytest.fixture()
def proxy(tmp_path, monkeypatch):
    secrets = tmp_path / "secrets.json"
    secrets.write_text(json.dumps({
        "case_sensitive": False,
        "min_literal_len": 4,
        "literals": [{"kind": "PASSWORD", "value": "my-real-password"}],
        "patterns": [{"kind": "EMPLOYEE_ID", "regex": "\\bEMP-[0-9]{6}\\b", "max_len": 16}],
    }), encoding="utf-8")
    vault = Vault(tmp_path / "vault.json", secret=b"0" * 32)
    detector = Detector(DetectorConfig(
        literals=[("PASSWORD", "my-real-password")],
        patterns=list(pii_proxy.BUILTIN_PATTERNS) + [
            pii_proxy.PatternSpec("EMPLOYEE_ID", "\\bEMP-[0-9]{6}\\b", 16),
        ],
    ))
    monkeypatch.setattr(pii_proxy, "SECRETS_FILE", str(secrets))
    monkeypatch.setattr(pii_proxy, "VAULT", vault)
    monkeypatch.setattr(pii_proxy, "DETECTOR", detector)
    return pii_proxy


def test_config_view_masks_values_and_lists_rules(proxy):
    with TestClient(proxy.app) as client:
        body = client.get("/config").json()
    assert body["exists"] is True
    assert body["mode"] == "fake"
    assert body["effective"]["literals"] == 1
    raw = json.dumps(body, ensure_ascii=False)
    assert "my-real-password" not in raw          # values are never returned in clear
    assert body["literals"] == [{"kind": "PASSWORD", "masked": "my****rd", "length": 16}]
    assert body["custom_patterns"][0]["kind"] == "EMPLOYEE_ID"
    assert body["custom_patterns"][0]["max_len"] == 16
    kinds = {item["kind"] for item in body["builtin_patterns"]}
    assert {"EMAIL_ADDRESS", "AWS_KEY", "SECRET_KEYWORD"} <= kinds
    assert body["issues"] == []


def test_config_view_reports_lint_issues(proxy, tmp_path, monkeypatch):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({
        "patterns": [{"kind": "EVIL", "regex": "^(a+)+$", "max_len": 32}],
    }), encoding="utf-8")
    monkeypatch.setattr(proxy, "SECRETS_FILE", str(bad))
    with TestClient(proxy.app) as client:
        body = client.get("/config").json()
    assert any("nested quantifiers" in issue for issue in body["issues"])


def test_dry_run_previews_what_the_model_would_see(proxy):
    before = proxy.VAULT.stats()["entries"]
    text = "工号 EMP-123456，密码 my-real-password，邮箱 a@b.co，password=DevTestPW42"
    with TestClient(proxy.app) as client:
        body = client.post("/config/dry-run", json={"text": text}).json()
    assert {m["kind"] for m in body["matches"]} >= {"EMPLOYEE_ID", "PASSWORD", "SECRET_KEYWORD", "EMAIL_ADDRESS"}
    assert "my-real-password" not in body["anonymized"]
    assert "EMP-123456" not in body["anonymized"]
    assert "DevTestPW42" not in body["anonymized"]
    assert "@example" in body["anonymized"]          # fake email shape
    assert proxy.VAULT.stats()["entries"] == before  # dry-run never touches the real vault


def test_dry_run_empty_text(proxy):
    with TestClient(proxy.app) as client:
        body = client.post("/config/dry-run", json={"text": ""}).json()
    assert body["matches"] == [] and body["anonymized"] == ""


def test_dry_run_accepts_missing_body(proxy):
    with TestClient(proxy.app) as client:
        resp = client.post("/config/dry-run")
    assert resp.status_code == 200
    assert resp.json()["matches"] == []
