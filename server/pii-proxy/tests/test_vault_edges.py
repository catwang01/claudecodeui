"""Edge-case tests for pii_vault (issue #24 hardening)."""

from __future__ import annotations

import json
import threading

import pytest

from pii_vault import ALIAS_RX, Vault, kind_of


def test_alias_format_and_kind_normalisation(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"0" * 32)
    alias = vault.alias_for("email address!", "a@b.co")
    assert kind_of(alias) == "EMAIL_ADDRESS"
    assert ALIAS_RX.fullmatch(alias), alias
    assert kind_of("PII_NOT_AN_ALIAS_x") is None
    assert kind_of("plain") is None


def test_alias_is_stable_for_unicode_and_long_values(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"1" * 32)
    for value in ["密码是秘密", "🔐 emoji value", "x" * 4096, "with space and, punctuation;"]:
        alias = vault.alias_for("SECRET", value)
        assert vault.alias_for("SECRET", value) == alias
        assert vault.restore_text("v=" + alias) == "v=" + value


def test_restore_leaves_unknown_aliases_and_plain_text_alone(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"2" * 32)
    text = "PII_EMAIL_zzzzzz and nothing else"
    assert vault.restore_text(text) == text


def test_value_that_looks_like_an_alias_is_not_recursively_restored(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"3" * 32)
    inner = vault.alias_for("EMAIL", "first@example.com")
    alias = vault.alias_for("SECRET", inner)  # value is itself an alias-shaped string
    assert vault.restore_text(alias) == inner
    assert vault.restore_text(vault.restore_text(alias)) == "first@example.com"


def test_restore_prefers_the_longest_alias(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"4" * 32)
    short = vault.alias_for("A", "short-value")
    long = vault.alias_for("B", "long-value")
    vault._reverse[short[:-1]] = "TRAP"  # a prefix that is not a real alias
    assert vault.restore_text("x " + short + " " + long) == "x short-value long-value"


def test_restore_obj_skips_signed_keys_recursively(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"5" * 32)
    alias = vault.alias_for("EMAIL", "a@b.co")
    payload = {"content": [
        {"type": "thinking", "thinking": "saw " + alias, "signature": alias},
        {"type": "text", "text": "mail " + alias},
    ]}
    out = vault.restore_obj(payload, skip_keys=("thinking", "signature", "redacted_thinking"))
    assert out["content"][0]["thinking"] == "saw " + alias
    assert out["content"][0]["signature"] == alias
    assert out["content"][1]["text"] == "mail a@b.co"


def test_mask_short_and_long_values(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"6" * 32)
    assert vault.mask(vault.alias_for("K", "ab")) == "****"
    assert vault.mask(vault.alias_for("K", "abcdef")) == "a***f"
    assert vault.mask(vault.alias_for("K", "abcdefgh")) == "ab****gh"
    assert vault.mask("PII_K_000000") == "****"  # unknown alias -> empty value


def test_persistence_round_trip_keeps_kind_and_alias(tmp_path):
    path = tmp_path / "v.json"
    first = Vault(path, secret=b"7" * 32)
    alias = first.alias_for("PASSWORD", "hunter2")
    first.save()
    second = Vault(path)
    assert second.alias_for("PASSWORD", "hunter2") == alias
    assert second.reveal(alias) == "hunter2"
    on_disk = json.loads(path.read_text("utf-8"))
    assert on_disk["entries"][0]["kind"] == "PASSWORD"


def test_corrupt_vault_file_does_not_crash(tmp_path):
    path = tmp_path / "v.json"
    path.write_text("{not json at all", encoding="utf-8")
    vault = Vault(path)
    assert vault.stats()["entries"] == 0
    assert vault.alias_for("K", "value-1234").startswith("PII_K_")

    path.write_text(json.dumps({"secret": "zz", "entries": [{"nope": 1}, "junk"]}), encoding="utf-8")
    vault = Vault(path)
    assert vault.stats()["entries"] == 0


def test_save_failure_is_swallowed(tmp_path):
    path = tmp_path / "dir-as-file"
    path.mkdir()
    vault = Vault(path, secret=b"8" * 32)
    vault.alias_for("K", "value-1234")
    vault.save()  # must not raise even though the target is a directory


def test_concurrent_alias_minting_is_consistent(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"9" * 32)
    results: list[str] = []
    lock = threading.Lock()

    def worker(i: int) -> None:
        alias = vault.alias_for("THREAD", "shared-value")
        with lock:
            results.append(alias)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(results)) == 1
    assert vault.stats()["entries"] == 1


def test_collision_extends_the_suffix(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"a" * 32)
    first = vault.alias_for("K", "value-one")
    # simulate a 6-hex collision with a different value by planting the mapping
    from pii_vault import kind_of as _kind_of

    colliding = "PII_K_" + first.split("_")[-1]
    vault._reverse[colliding] = "other-value"
    second = vault.alias_for("K", "value-one")
    assert second == first  # same value keeps its alias
    third = vault.alias_for("K", "value-two")
    assert third.startswith("PII_K_")


def test_empty_and_none_like_inputs(tmp_path):
    vault = Vault(tmp_path / "v.json", secret=b"b" * 32)
    assert vault.restore_text("") == ""
    assert vault.restore_obj(None) is None
    assert vault.restore_obj(123) == 123
    assert vault.restore_obj([]) == []
