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
import random
import re
import secrets
import threading
from pathlib import Path
from typing import Any, Iterable

from pii_surrogates import make_surrogate

ALIAS_RX = re.compile(r"PII_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_([0-9a-f]{6,16})(?![0-9a-f])")
KIND_RX = re.compile(r"[^A-Z0-9]+")

DEFAULT_VAULT_PATH = "~/.pii-proxy/vault.json"
_HEX_LEN = 6
# "fake"  : format-preserving realistic surrogate (default, see pii_surrogates.py)
# "token" : opaque PII_<KIND>_<hex> token (kept for compatibility / A-B testing)
DEFAULT_MODE = "fake"
VALID_MODES = ("fake", "token")


def _normalize_kind(kind: str) -> str:
    clean = KIND_RX.sub("_", (kind or "SECRET").upper()).strip("_")
    return (clean or "SECRET")[:16]


def kind_of(alias: str) -> str | None:
    """Extract the KIND part of an alias, or None if it is not an alias."""
    match = ALIAS_RX.fullmatch(alias)
    return match.group(1) if match else None


class Vault:
    """Deterministic alias <-> original-value mapping."""

    def __init__(
        self,
        path: str | os.PathLike[str] | None = None,
        secret: bytes | None = None,
        mode: str | None = None,
    ) -> None:
        self.path = Path(os.path.expanduser(str(path or DEFAULT_VAULT_PATH)))
        self._lock = threading.RLock()
        self._forward: dict[tuple[str, str], str] = {}
        self._reverse: dict[str, str] = {}
        self._kinds: dict[str, str] = {}
        self._secret: bytes = secret if secret is not None else secrets.token_bytes(32)
        self._dirty = False
        requested = (mode or os.getenv("PII_PROXY_PLACEHOLDER_MODE", DEFAULT_MODE) or DEFAULT_MODE).lower()
        self._mode = requested if requested in VALID_MODES else DEFAULT_MODE
        self._restore_rx: re.Pattern[str] | None = None
        if secret is None:
            self._load()

    # ------------------------------------------------------------------ core

    def surrogate_for(self, kind: str, value: str) -> str:
        """Return the deterministic placeholder for *value* (minting it if needed).

        fake mode  -> a realistic, format-preserving fake (an email stays an
                      email, a private IP stays a private IP);
        token mode -> the legacy opaque PII_<KIND>_<hex> token.
        """
        kind = _normalize_kind(kind)
        key = (kind, value)
        with self._lock:
            existing = self._forward.get(key)
            if existing is not None:
                return existing
            if self._mode == "token":
                placeholder = self._mint_token(kind, value)
            else:
                placeholder = self._mint_surrogate(kind, value)
            self._forward[key] = placeholder
            self._reverse[placeholder] = value
            self._kinds[placeholder] = kind
            self._restore_rx = None
            # Only touch memory here: mark dirty and let the caller batch the
            # disk write via flush(). Rewriting the whole table on every mint is
            # O(n^2) write amplification and blocks the request (issue #50).
            self._dirty = True
            return placeholder

    # Backwards-compatible name (tests and callers used alias_for).
    alias_for = surrogate_for

    def _mint_token(self, kind: str, value: str) -> str:
        digest = hmac.new(self._secret, ("%s\x00%s" % (kind, value)).encode("utf-8"), hashlib.sha256).hexdigest()
        length = _HEX_LEN
        while True:
            token = "PII_%s_%s" % (kind, digest[:length])
            owner = self._reverse.get(token)
            if owner is None or owner == value:
                return token
            length += 1

    def _mint_surrogate(self, kind: str, value: str) -> str:
        seed = hmac.new(self._secret, ("%s\x00%s" % (kind, value)).encode("utf-8"), hashlib.sha256).digest()
        for attempt in range(64):
            rng = random.Random(int.from_bytes(hashlib.sha256(seed + attempt.to_bytes(2, "big")).digest()[:8], "big"))
            candidate = make_surrogate(kind, value, rng)
            if not candidate or candidate == value:
                continue
            owner = self._reverse.get(candidate)
            if owner is None or owner == value:
                return candidate
        # Astronomically unlikely; fall back to a token so we never lose a value.
        return self._mint_token(kind, value)

    def kind_of_placeholder(self, placeholder: str) -> str | None:
        with self._lock:
            return self._kinds.get(placeholder)

    def reveal(self, alias: str) -> str | None:
        with self._lock:
            return self._reverse.get(alias)

    def _placeholder_regex(self) -> re.Pattern[str] | None:
        """One alternation over every known placeholder (longest first)."""
        if self._restore_rx is not None:
            return self._restore_rx
        if not self._reverse:
            return None
        ordered = sorted(self._reverse, key=len, reverse=True)
        self._restore_rx = re.compile("|".join(re.escape(key) for key in ordered))
        return self._restore_rx

    def placeholders(self) -> list[str]:
        """All known placeholders (used by the streaming hold-back prefix set)."""
        with self._lock:
            return list(self._reverse)

    def placeholder_pattern(self) -> re.Pattern[str] | None:
        """Compiled alternation over known placeholders, for streaming hold-back."""
        with self._lock:
            return self._placeholder_regex()

    def restore_text(self, text: str) -> str:
        """Replace every known placeholder with its original value (exact lookup)."""
        if not text:
            return text
        with self._lock:
            regex = self._placeholder_regex()
            if regex is None:
                return text
            reverse = self._reverse
        return regex.sub(lambda match: reverse.get(match.group(0), match.group(0)), text)

    def find_placeholders(self, text: str) -> list[str]:
        """Return the known placeholders present in *text* (for logging/UI)."""
        if not text:
            return []
        with self._lock:
            regex = self._placeholder_regex()
            if regex is None:
                return []
        return [match.group(0) for match in regex.finditer(text)]

    def max_placeholder_len(self) -> int:
        with self._lock:
            return max((len(key) for key in self._reverse), default=24)

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
            return {
                "entries": len(self._reverse),
                "path": str(self.path),
                "persistent": bool(self._secret),
                "mode": self._mode,
                "max_placeholder_len": self.max_placeholder_len(),
            }

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
            self._kinds[alias] = kind

    def save(self) -> None:
        with self._lock:
            self._save_locked(force=True)

    def flush(self) -> None:
        """Persist pending minted aliases in a single write.

        Minting (`surrogate_for`) only updates memory and marks the vault dirty;
        callers flush once at a request boundary so the whole table is not
        rewritten per mint. Cheap no-op when nothing has been minted since the
        last flush. Unlike `save`, this does not force a write when clean.
        """
        with self._lock:
            self._save_locked()

    def _save_locked(self, force: bool = False) -> None:
        if not self._dirty and not force:
            return
        payload = {
            "version": 2,
            "secret": self._secret.hex(),
            "entries": [
                {"alias": placeholder, "kind": kind, "value": value}
                for (kind, value), placeholder in sorted(self._forward.items(), key=lambda kv: kv[1])
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
