"""Deterministic pseudonym vault for the PII proxy (v2).

Replaces the old AES-blob scheme:

    PII_<KIND>_<6hex>        e.g. PII_EMAIL_7f3a9c

* deterministic - same (kind, value) always maps to the same alias, across
  restarts and processes (HMAC over a persisted secret), so multi-turn
  reasoning stays consistent and prompt prefixes stay byte-stable;
* readable and format-safe - the alphabet is [A-Z0-9_], so the alias never
  needs JSON/HTML/shell escaping and never looks like a "magic number" the
  model might try to compute with;
* restorable by exact lookup - no regex scanning of model output required.

The vault file is local, mode 0600, and holds the alias <-> value mapping so
that aliases minted before a restart still restore afterwards.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
from pathlib import Path
from typing import Any, Iterable

ALIAS_RX = re.compile(r"PII_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_([0-9a-f]{6,16})(?![0-9a-f])")
KIND_RX = re.compile(r"[^A-Z0-9]+")

DEFAULT_VAULT_PATH = "~/.pii-proxy/vault.json"
_HEX_LEN = 6


def _normalize_kind(kind: str) -> str:
    clean = KIND_RX.sub("_", (kind or "SECRET").upper()).strip("_")
    return (clean or "SECRET")[:16]


def kind_of(alias: str) -> str | None:
    """Extract the KIND part of an alias, or None if it is not an alias."""
    match = ALIAS_RX.fullmatch(alias)
    return match.group(1) if match else None


class Vault:
    """Deterministic alias <-> original-value mapping."""

    def __init__(self, path: str | os.PathLike[str] | None = None, secret: bytes | None = None) -> None:
        self.path = Path(os.path.expanduser(str(path or DEFAULT_VAULT_PATH)))
        self._lock = threading.RLock()
        self._forward: dict[tuple[str, str], str] = {}
        self._reverse: dict[str, str] = {}
        self._secret: bytes = secret if secret is not None else secrets.token_bytes(32)
        self._dirty = False
        if secret is None:
            self._load()

    # ------------------------------------------------------------------ core

    def alias_for(self, kind: str, value: str) -> str:
        """Return the deterministic alias for *value* (minting one if needed)."""
        kind = _normalize_kind(kind)
        key = (kind, value)
        with self._lock:
            existing = self._forward.get(key)
            if existing is not None:
                return existing
            digest = hmac.new(self._secret, ("%s\x00%s" % (kind, value)).encode("utf-8"), hashlib.sha256).hexdigest()
            length = _HEX_LEN
            while True:
                alias = "PII_%s_%s" % (kind, digest[:length])
                owner = self._reverse.get(alias)
                if owner is None or owner == value:
                    break
                length += 1  # extremely unlikely collision: extend the suffix
            self._forward[key] = alias
            self._reverse[alias] = value
            self._dirty = True
            self._save_locked()
            return alias

    def reveal(self, alias: str) -> str | None:
        with self._lock:
            return self._reverse.get(alias)

    def restore_text(self, text: str) -> str:
        """Replace every known alias with its original value (exact lookup)."""
        if not text or "PII_" not in text:
            return text
        with self._lock:
            reverse = self._reverse

        def _sub(match: re.Match[str]) -> str:
            return reverse.get(match.group(0), match.group(0))

        return ALIAS_RX.sub(_sub, text)

    def restore_obj(self, obj: Any, *, skip_keys: Iterable[str] = ()) -> Any:
        """Recursively restore string values, skipping the given dict keys."""
        skip = {k.lower() for k in skip_keys}
        if isinstance(obj, str):
            return self.restore_text(obj)
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                if isinstance(k, str) and k.lower() in skip:
                    out[k] = v  # e.g. signed thinking blocks must stay byte-identical
                else:
                    out[k] = self.restore_obj(v, skip_keys=skip_keys)
            return out
        if isinstance(obj, list):
            return [self.restore_obj(item, skip_keys=skip_keys) for item in obj]
        return obj

    def mask(self, alias: str) -> str:
        value = self.reveal(alias) or ""
        if len(value) <= 2:
            return "****"
        if len(value) <= 6:
            return value[0] + "***" + value[-1]
        return value[:2] + "****" + value[-2:]

    def stats(self) -> dict:
        with self._lock:
            return {"entries": len(self._reverse), "path": str(self.path), "persistent": bool(self._secret)}

    # -------------------------------------------------------------- persistence

    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return
        except Exception:
            return
        secret = raw.get("secret")
        if isinstance(secret, str):
            try:
                self._secret = bytes.fromhex(secret)
            except ValueError:
                pass
        for entry in raw.get("entries", []):
            try:
                alias, value = entry["alias"], entry["value"]
            except Exception:
                continue
            kind = entry.get("kind") or kind_of(alias) or "SECRET"
            self._forward[(kind, value)] = alias
            self._reverse[alias] = value

    def save(self) -> None:
        with self._lock:
            self._save_locked(force=True)

    def _save_locked(self, force: bool = False) -> None:
        if not self._dirty and not force:
            return
        payload = {
            "version": 2,
            "secret": self._secret.hex(),
            "entries": [
                {"alias": alias, "kind": kind_of(alias) or "SECRET", "value": value}
                for alias, value in sorted(self._reverse.items())
            ],
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), "utf-8")
            os.chmod(tmp, 0o600)
            tmp.replace(self.path)
            self._dirty = False
        except Exception:
            # Never fail a request because the vault could not be persisted.
            pass
