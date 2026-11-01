"""PII proxy v2 - local redaction gateway for the Claude Code CLI.

What changed vs v1 (see docs/superpowers/specs/2026-05-16-pii-proxy-design.md):

* placeholders are deterministic readable aliases (format PII_KIND_hex6) instead
  of opaque AES blobs, and are restored by exact lookup (see pii_vault.py);
* the response path is protocol aware: SSE frames are parsed, only the fields
  that may carry placeholders are rewritten and frames are re-serialised with
  json.dumps (see pii_stream.py), so a secret containing quotes or backslashes
  can no longer corrupt the stream;
* signed thinking blocks are never rewritten (rewriting them invalidates the
  signature and makes the upstream reject the whole conversation);
* detection is deterministic and tiered: T0 user-supplied literal values,
  T1 bounded built-in regexes. The presidio/spacy NER tier is optional and off
  by default, so the default path has no heavy ML dependency.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse

from pii_detect import Detector, DetectorConfig, PatternSpec
from pii_stream import SSERestorer
from pii_vault import Vault

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("pii-proxy")

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

MESSAGES_PATHS = {"v1/messages", "v1/messages/count_tokens"}
# Fields that must stay byte-identical: Anthropic signs them and rejects any
# later replay whose text no longer matches the signature.
SIGNED_KEYS = ("thinking", "signature", "redacted_thinking", "encrypted_content")
# Floor for the streaming hold-back window; the real value is the longest
# placeholder the vault knows about (surrogates stay under 256 chars).
RESTORE_MAX_LEN = 48


def restore_window() -> int:
    return max(RESTORE_MAX_LEN, VAULT.max_placeholder_len())
# Never rewrite binary payloads (images / documents); report them instead.
BINARY_KEYS = ("data", "base64", "image_url")


def _resolve_upstream_url() -> str:
    url = os.getenv("PII_PROXY_UPSTREAM_URL")
    if url:
        return url.rstrip("/")
    try:
        settings = json.loads((pathlib.Path.home() / ".claude" / "settings.json").read_text("utf-8"))
        url = settings.get("env", {}).get("ANTHROPIC_BASE_URL")
        if url:
            return url.rstrip("/")
    except Exception:
        pass
    return "https://api.anthropic.com"


UPSTREAM_URL = _resolve_upstream_url()
SECRETS_FILE = os.getenv("PII_PROXY_SECRETS_FILE", "~/.pii-proxy/secrets.json")
VAULT_FILE = os.getenv("PII_PROXY_VAULT_FILE", "~/.pii-proxy/vault.json")

# T1: bounded built-in patterns. Every max_len is an upper bound, which is what
# lets the streaming layer hold back a bounded tail instead of guessing.
BUILTIN_PATTERNS: list[PatternSpec] = [
    PatternSpec("EMAIL_ADDRESS", r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}", 128, False),
    PatternSpec("AWS_KEY", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", 64, True),
    PatternSpec("JWT_TOKEN", r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b", 4096, True),
    PatternSpec("PRIVATE_KEY", r"-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,4096}?-----END [A-Z ]{0,40}PRIVATE KEY-----", 4096, True),
    PatternSpec("BASIC_AUTH_URL", r"\b[a-z][a-z0-9+.\-]{1,20}://[^\s:/@]{1,64}:[^\s:/@]{4,128}@", 256, False),
    PatternSpec("GITHUB_TOKEN", r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b", 128, True),
    PatternSpec("SECRET_KEYWORD", r"(?i)\b(?:password|passwd|pwd|passphrase|secret|api[_\-]?key|auth[_\-]?token|access[_\-]?token|private[_\-]?key|db[_\-]?pass(?:word)?|密码|口令)\b\s*[=:：]\s*[\"']?([^\s\"',;\[\]{}()<>]{4,256})", 300, False),
    PatternSpec("IPV4", r"\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b", 32, True),
    PatternSpec("CN_MOBILE", r"\b(?:\+?86[- ]?)?1[3-9]\d{9}\b", 32, True),
    PatternSpec("CN_ID", r"\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]\b", 32, True),
]


def load_detector() -> Detector:
    cfg = DetectorConfig.load(SECRETS_FILE)
    kinds = {p.kind for p in cfg.patterns}
    patterns = list(cfg.patterns) + [p for p in BUILTIN_PATTERNS if p.kind not in kinds]
    merged = DetectorConfig(
        literals=cfg.literals,
        patterns=patterns,
        case_sensitive=cfg.case_sensitive,
        min_literal_len=cfg.min_literal_len,
    )
    for issue in merged.lint():
        logger.warning("pii config: %s", issue)
    return Detector(merged)


DETECTOR = load_detector()
VAULT = Vault(VAULT_FILE)

# --------------------------------------------------------------------------- #
# Observability (shapes kept compatible with the settings UI)
# --------------------------------------------------------------------------- #

_log_buffer: deque = deque(maxlen=200)
_pii_groups: dict = {}
_stats = {
    "requests": 0,
    "anonymized_values": 0,
    "restored_values": 0,
    "uncovered_binary": 0,
    "signed_blocks_skipped": 0,
}


def _aliases_of(text: str) -> list[str]:
    return VAULT.find_placeholders(text)


def _log_diff(req_id: str, label: str, before: str, after: str) -> None:
    import difflib

    if before == after:
        return
    ts = datetime.now(timezone.utc).isoformat()
    for alias in _aliases_of(after):
        kind = VAULT.kind_of_placeholder(alias) or "SECRET"
        entry = _pii_groups.setdefault(alias, {"entity_type": kind, "hits": deque(maxlen=200)})
        entry["hits"].appendleft({"req_id": req_id, "ts": ts, "label": label})
    diff = "\n".join(
        difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                             fromfile="a/" + label, tofile="b/" + label, lineterm="")
    )
    if diff:
        _log_buffer.append({"id": req_id, "ts": ts, "label": label, "diff": diff})


# --------------------------------------------------------------------------- #
# Request anonymization
# --------------------------------------------------------------------------- #

def _anonymize_text(text: str, req_id: str, label: str) -> str:
    matches = DETECTOR.scan(text)
    if not matches:
        return text
    out = text
    for match in sorted(matches, key=lambda m: m.start, reverse=True):
        alias = VAULT.surrogate_for(match.kind, match.value)
        out = out[: match.start] + alias + out[match.end:]
        _stats["anonymized_values"] += 1
    _log_diff(req_id, label, text, out)
    return out


def _walk_anonymize(obj: Any, path: str, req_id: str) -> Any:
    """Recursively anonymize every string, skipping signed and binary payloads."""
    if isinstance(obj, str):
        return _anonymize_text(obj, req_id, path)
    if isinstance(obj, list):
        return [_walk_anonymize(item, path + "[" + str(i) + "]", req_id) for i, item in enumerate(obj)]
    if isinstance(obj, dict):
        block_type = obj.get("type")
        if isinstance(block_type, str) and block_type.lower() in SIGNED_KEYS:
            _stats["signed_blocks_skipped"] += 1
            return obj
        out: dict = {}
        for key, value in obj.items():
            if isinstance(key, str) and key.lower() in SIGNED_KEYS:
                _stats["signed_blocks_skipped"] += 1
                out[key] = value
                continue
            if isinstance(key, str) and key.lower() in BINARY_KEYS and isinstance(value, str) and len(value) > 256:
                _stats["uncovered_binary"] += 1
                out[key] = value
                continue
            out[key] = _walk_anonymize(value, path + "." + key, req_id)
        return out
    return obj


def anonymize_request(data: Any, req_id: str) -> tuple[Any, bool]:
    before = json.dumps(data, sort_keys=True)
    out = _walk_anonymize(data, "request", req_id)
    return out, json.dumps(out, sort_keys=True) != before


# --------------------------------------------------------------------------- #
# Response restoration
# --------------------------------------------------------------------------- #

def _count_aliases(node: Any) -> int:
    found = 0
    if isinstance(node, str):
        found += len(VAULT.find_placeholders(node))
    elif isinstance(node, dict):
        for value in node.values():
            found += _count_aliases(value)
    elif isinstance(node, list):
        for item in node:
            found += _count_aliases(item)
    return found


def restore_json_payload(body: bytes, req_id: str) -> bytes:
    try:
        data = json.loads(body)
    except Exception:
        return body
    restored = VAULT.restore_obj(data, skip_keys=SIGNED_KEYS)
    count = _count_aliases(data)
    if count:
        _stats["restored_values"] += count
    return json.dumps(restored, ensure_ascii=False).encode("utf-8")


# --------------------------------------------------------------------------- #
# FastAPI app
# --------------------------------------------------------------------------- #

_client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=30.0, read=None, write=None, pool=None),
    follow_redirects=True,
    trust_env=False,
)

_HOP_BY_HOP = {"host", "content-length", "transfer-encoding", "connection", "keep-alive", "content-encoding"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    VAULT.save()
    await _client.aclose()


app = FastAPI(title="PII Proxy", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "upstream": UPSTREAM_URL,
        "mode": "v2-aliases",
        "detector": DETECTOR.health(),
        "vault": VAULT.stats(),
        "stats": dict(_stats),
    }


@app.get("/logs")
async def get_logs():
    return {"entries": list(_log_buffer)}


@app.delete("/logs")
async def clear_logs():
    _log_buffer.clear()
    _pii_groups.clear()
    return {"ok": True}


@app.get("/pii-groups")
async def get_pii_groups():
    groups = []
    for alias, value in _pii_groups.items():
        hits = list(value["hits"])
        groups.append({
            "token_key": alias,
            "entity_type": value["entity_type"],
            "masked": VAULT.mask(alias),
            "count": len(hits),
            "last_seen": hits[0]["ts"] if hits else "",
            "occurrences": hits,
        })
    groups.sort(key=lambda g: g["last_seen"], reverse=True)
    return {"groups": groups}


@app.delete("/pii-groups")
async def clear_pii_groups():
    _pii_groups.clear()
    return {"ok": True}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy(request: Request, path: str):
    t0 = time.monotonic()
    body = await request.body()
    req_id = uuid.uuid4().hex[:8]
    _stats["requests"] += 1

    if request.method == "POST" and path in MESSAGES_PATHS and body:
        try:
            data = json.loads(body)
            data, modified = anonymize_request(data, req_id)
            if modified:
                body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        except Exception as exc:  # fail-open: never block a request because of us
            logger.warning("[%s] failed to anonymize request: %s", req_id, exc)

    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}
    upstream_url = UPSTREAM_URL + "/" + path
    if request.url.query:
        upstream_url += "?" + request.url.query

    last_exc: Exception | None = None
    upstream = None
    for attempt in range(4):
        if attempt:
            await asyncio.sleep(2 ** (attempt - 1))
        try:
            upstream = await _client.send(
                _client.build_request(request.method, upstream_url, headers=headers, content=body),
                stream=True,
            )
            break
        except httpx.TransportError as exc:
            last_exc = exc
    if upstream is None:
        raise last_exc  # type: ignore[misc]

    content_type = upstream.headers.get("content-type", "")
    resp_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in _HOP_BY_HOP}

    if "text/event-stream" in content_type:
        restorer = SSERestorer(VAULT.restore_text, restore_window())

        async def _stream():
            try:
                async for chunk in upstream.aiter_bytes():
                    for frame in restorer.feed(chunk):
                        yield frame
                for frame in restorer.flush():
                    yield frame
            finally:
                _stats["restored_values"] += restorer.stats.get("restored", 0)
                await upstream.aclose()

        logger.info("[%s] %s %s -> %d (SSE) %.1fms", req_id, request.method, path, upstream.status_code, (time.monotonic() - t0) * 1000)
        return StreamingResponse(_stream(), status_code=upstream.status_code, headers=resp_headers)

    try:
        await upstream.aread()
        resp_body = upstream.content
        if "application/json" in content_type:
            resp_body = restore_json_payload(resp_body, req_id)
    finally:
        await upstream.aclose()
    logger.info("[%s] %s %s -> %d %.1fms", req_id, request.method, path, upstream.status_code, (time.monotonic() - t0) * 1000)
    resp_headers["content-length"] = str(len(resp_body))
    return Response(content=resp_body, status_code=upstream.status_code, headers=resp_headers)
