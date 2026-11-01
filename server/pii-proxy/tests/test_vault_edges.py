"""Edge-case tests for pii_vault (issue #24/#36).

Covers both placeholder modes:
  * fake  (default): realistic format-preserving surrogates;
  * token          : the legacy opaque PII_<KIND>_<hex> token.
"""

from __future__ import annotations

import json
import re
import threading

import pytest

from pii_vault import ALIAS_RX, Vault, kind_of

EMAIL = "alice.chen@corp.example"
IPV4 = "117.72.145.38"
PHONE = "13812345678"
CN_ID = "11010519491231002X"
AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
GITHUB = "ghp_" + "a" * 36
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
BASIC = "postgres://user:pass1234@db.internal:5432/app"
KEYWORD = "password=SuperSecret123"


def _vault(tmp_path, mode=None, name="v.json"):
    return Vault(tmp_path / name, secret=b"0" * 32, mode=mode)


# --------------------------------------------------------------------------- #
# fake mode: shape preservation
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("kind,value,shape", [
    ("EMAIL_ADDRESS", EMAIL, r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}"),
    ("IPV4", IPV4, r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}"),
    ("CN_MOBILE", PHONE, r"1[3-9]\d{9}"),
    ("CN_ID", CN_ID, r"\d{17}[0-9X]"),
    ("AWS_KEY", AWS_KEY, r"AKIA[0-9A-Z]{16}"),
    ("GITHUB_TOKEN", GITHUB, r"ghp_[A-Za-z0-9]{36}"),
    ("JWT_TOKEN", JWT, r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),
    ("PRIVATE_KEY", PEM, r"-----BEGIN RSA PRIVATE KEY-----.*-----END RSA PRIVATE KEY-----"),
    ("BASIC_AUTH_URL", BASIC, r"postgres://[A-Za-z0-9._\-]+:[^@\s]+@"),
])
def test_fake_mode_preserves_shape(tmp_path, kind, value, shape):
    vault = _vault(tmp_path)
    fake = vault.surrogate_for(kind, value)
    assert fake != value
    assert re.fullmatch(shape, fake, re.S), (kind, fake)


def test_fake_mode_keeps_password_keyword(tmp_path):
    vault = _vault(tmp_path)
    fake = vault.surrogate_for("SECRET_KEYWORD", KEYWORD)
    assert fake.startswith("password=")
    assert "SuperSecret123" not in fake
    assert len(fake) >= len("password=") + 8


def test_fake_mode_does_not_reuse_the_original_characters(tmp_path):
    vault = _vault(tmp_path)
    fake = vault.surrogate_for("PASSWORD", "ZzQqWwEeRrTt")
    assert fake != "ZzQqWwEeRrTt"
    assert fake[:4] != "ZzQq"


def test_fake_mode_is_deterministic_and_persistent(tmp_path):
    path = tmp_path / "v.json"
    first = Vault(path, secret=b"1" * 32)
    fake = first.surrogate_for("EMAIL_ADDRESS", EMAIL)
    first.save()
    second = Vault(path, mode="fake")
    assert second.surrogate_for("EMAIL_ADDRESS", EMAIL) == fake
    assert second.restore_text("mail " + fake) == "mail " + EMAIL
    on_disk = json.loads(path.read_text("utf-8"))
    assert on_disk["entries"][0]["kind"] == "EMAIL_ADDRESS"


def test_fake_mode_distinct_values_get_distinct_fakes(tmp_path):
    vault = _vault(tmp_path)
    fakes = {vault.surrogate_for("EMAIL_ADDRESS", "user%d@corp.example" % i) for i in range(40)}
    assert len(fakes) == 40
    assert all(re.fullmatch(r"[^@\s]+@[^@\s]+", fake) for fake in fakes)


def test_fake_mode_same_value_same_fake_across_kinds(tmp_path):
    vault = _vault(tmp_path)
    assert vault.surrogate_for("EMAIL_ADDRESS", EMAIL) == vault.surrogate_for("EMAIL_ADDRESS", EMAIL)
    assert vault.kind_of_placeholder(vault.surrogate_for("EMAIL_ADDRESS", EMAIL)) == "EMAIL_ADDRESS"


def test_restore_text_handles_many_placeholders_and_longest_first(tmp_path):
    vault = _vault(tmp_path)
    pairs = [(kind, value) for kind, value in [
        ("EMAIL_ADDRESS", EMAIL), ("IPV4", IPV4), ("CN_MOBILE", PHONE), ("AWS_KEY", AWS_KEY),
    ]]
    text = " ".join("v=%s" % vault.surrogate_for(kind, value) for kind, value in pairs)
    restored = vault.restore_text(text)
    for _, value in pairs:
        assert value in restored
    # restore is idempotent
    assert vault.restore_text(restored) == restored


def test_restore_obj_skips_signed_keys_recursively(tmp_path):
    vault = _vault(tmp_path)
    fake = vault.surrogate_for("EMAIL_ADDRESS", EMAIL)
    payload = {"content": [
        {"type": "thinking", "thinking": "saw " + fake, "signature": fake},
        {"type": "text", "text": "mail " + fake},
    ]}
    out = vault.restore_obj(payload, skip_keys=("thinking", "signature", "redacted_thinking"))
    assert out["content"][0]["thinking"] == "saw " + fake
    assert out["content"][0]["signature"] == fake
    assert out["content"][1]["text"] == "mail " + EMAIL


def test_mask_never_reveals_the_value(tmp_path):
    vault = _vault(tmp_path)
    fake = vault.surrogate_for("EMAIL_ADDRESS", EMAIL)
    masked = vault.mask(fake)
    assert masked == "al****le"
    assert JSON_SAFE(masked)


def JSON_SAFE(text: str) -> bool:
    return "\"" not in text and text.isprintable()


def test_stats_report_mode_and_window(tmp_path):
    vault = _vault(tmp_path)
    fake = vault.surrogate_for("EMAIL_ADDRESS", EMAIL)
    stats = vault.stats()
    assert stats["mode"] == "fake" and stats["entries"] == 1
    assert stats["max_placeholder_len"] == len(fake)
    assert vault.max_placeholder_len() == len(fake)


def test_unknown_placeholders_and_plain_text_are_left_alone(tmp_path):
    vault = _vault(tmp_path)
    text = "PII_EMAIL_zzzzzz and some@other.example"
    assert vault.restore_text(text) == text


def test_value_that_looks_like_a_placeholder_is_not_recursed(tmp_path):
    vault = _vault(tmp_path)
    inner = vault.surrogate_for("EMAIL_ADDRESS", EMAIL)
    outer = vault.surrogate_for("SECRET", inner)
    assert vault.restore_text(outer) == inner
    assert vault.restore_text(vault.restore_text(outer)) == EMAIL


# --------------------------------------------------------------------------- #
# token mode (legacy, still supported)
# --------------------------------------------------------------------------- #

def test_token_mode_still_produces_the_opaque_format(tmp_path):
    vault = _vault(tmp_path, mode="token")
    token = vault.surrogate_for("EMAIL_ADDRESS", EMAIL)
    assert ALIAS_RX.fullmatch(token), token
    assert kind_of(token) == "EMAIL_ADDRESS"
    assert vault.restore_text("mail " + token) == "mail " + EMAIL


def test_token_mode_collision_extends_the_suffix(tmp_path):
    vault = _vault(tmp_path, mode="token")
    first = vault.surrogate_for("K", "value-one")
    vault._reverse["PII_K_" + first.split("_")[-1]] = "other-value"
    assert vault.surrogate_for("K", "value-one") == first
    assert vault.surrogate_for("K", "value-two").startswith("PII_K_")


def test_mode_comes_from_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PII_PROXY_PLACEHOLDER_MODE", "token")
    vault = _vault(tmp_path)
    assert vault.surrogate_for("EMAIL_ADDRESS", EMAIL).startswith("PII_")
    monkeypatch.setenv("PII_PROXY_PLACEHOLDER_MODE", "nonsense")
    assert _vault(tmp_path, name="v2.json").stats()["mode"] == "fake"


# --------------------------------------------------------------------------- #
# robustness
# --------------------------------------------------------------------------- #

def test_corrupt_vault_file_does_not_crash(tmp_path):
    path = tmp_path / "v.json"
    path.write_text("{not json at all", encoding="utf-8")
    vault = Vault(path)
    assert vault.stats()["entries"] == 0
    fake = vault.surrogate_for("EMAIL_ADDRESS", EMAIL)
    assert fake and vault.restore_text(fake) == EMAIL

    path.write_text(json.dumps({"secret": "zz", "entries": [{"nope": 1}, "junk"]}), encoding="utf-8")
    assert Vault(path).stats()["entries"] == 0


def test_save_failure_is_swallowed(tmp_path):
    path = tmp_path / "dir-as-file"
    path.mkdir()
    vault = Vault(path, secret=b"8" * 32)
    vault.surrogate_for("EMAIL_ADDRESS", EMAIL)
    vault.save()


def test_minting_batches_disk_writes_instead_of_rewriting_per_entry(tmp_path, monkeypatch):
    """Regression (issue #50): every new alias used to serialize + rewrite the
    whole vault (O(n^2) write amplification, blocking). Minting must stay in
    memory; a single `flush()` persists the batch."""
    path = tmp_path / "v.json"
    vault = Vault(path, secret=b"2" * 32)
    writes = {"n": 0}
    original = vault._save_locked

    def counting(force: bool = False) -> None:
        if vault._dirty or force:  # only count calls that actually write
            writes["n"] += 1
        original(force=force)

    monkeypatch.setattr(vault, "_save_locked", counting)

    values = ["user%d@corp.example" % i for i in range(60)]
    for value in values:
        vault.surrogate_for("EMAIL_ADDRESS", value)

    assert writes["n"] == 0, "minting must not touch the disk"
    assert vault.stats()["entries"] == 60

    vault.flush()
    assert writes["n"] == 1, "the whole batch is one write"
    vault.flush()
    assert writes["n"] == 1, "flushing a clean vault is a no-op"

    on_disk = json.loads(path.read_text("utf-8"))
    assert len(on_disk["entries"]) == 60
    reloaded = Vault(path)
    assert reloaded.stats()["entries"] == 60
    for value in values:
        # Deterministic across the restart: same value -> same alias.
        assert reloaded.surrogate_for("EMAIL_ADDRESS", value) == vault.surrogate_for("EMAIL_ADDRESS", value)


def test_concurrent_minting_is_consistent(tmp_path):
    vault = _vault(tmp_path)
    results: list[str] = []
    lock = threading.Lock()

    def worker() -> None:
        fake = vault.surrogate_for("EMAIL_ADDRESS", EMAIL)
        with lock:
            results.append(fake)

    threads = [threading.Thread(target=worker) for _ in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(set(results)) == 1
    assert vault.stats()["entries"] == 1


def test_empty_and_none_like_inputs(tmp_path):
    vault = _vault(tmp_path)
    assert vault.restore_text("") == ""
    assert vault.restore_obj(None) is None
    assert vault.restore_obj(123) == 123
    assert vault.restore_obj([]) == []


def test_long_value_is_capped(tmp_path):
    vault = _vault(tmp_path)
    fake = vault.surrogate_for("PRIVATE_KEY", "-----BEGIN RSA PRIVATE KEY-----\n" + "A" * 5000 + "\n-----END RSA PRIVATE KEY-----")
    assert 0 < len(fake) <= 256
