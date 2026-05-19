import os
import re
import json
import uuid
import hmac
import hashlib
import difflib
import base64
import codecs
import secrets
import logging
import pathlib
import time
import asyncio
from functools import lru_cache
from collections import deque
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import List

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding as crypto_padding
from cryptography.hazmat.backends import default_backend
from presidio_analyzer import AnalyzerEngine, EntityRecognizer, RecognizerResult
from presidio_analyzer.nlp_engine import NlpArtifacts, NlpEngineProvider

# detect-secrets: 检测结构化密钥（JWT、AWS key、Basic Auth、PEM 私钥、带引号的关键词）
try:
    from detect_secrets.settings import transient_settings as _ds_transient
    from detect_secrets.core.scan import scan_line as _ds_scan_line
    _DS_AVAILABLE = True
except ImportError:
    _DS_AVAILABLE = False

_DS_CONFIG = {
    "plugins_used": [
        {"name": "KeywordDetector"},       # password = "value"（引号值）
        {"name": "PrivateKeyDetector"},    # -----BEGIN * PRIVATE KEY-----
        {"name": "JwtTokenDetector"},      # eyJ... JWT tokens
        {"name": "BasicAuthDetector"},     # https://user:pass@host
        {"name": "AWSKeyDetector"},        # AKIA...
    ]
}

_DS_TYPE_MAP = {
    "Secret Keyword":          "SECRET_KEYWORD",
    "Private Key":             "PRIVATE_KEY",
    "JSON Web Token":          "JWT_TOKEN",
    "Basic Auth Credentials":  "BASIC_AUTH",
    "AWS Access Key":          "AWS_KEY",
}

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("pii-proxy")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _resolve_upstream_url() -> str:
    """Mirror tap.js resolveAnthropicBaseUrl: env var → settings.json → default."""
    # 1. Explicit override
    url = os.getenv("PII_PROXY_UPSTREAM_URL")
    if url:
        return url.rstrip("/")
    # 2. ~/.claude/settings.json → env.ANTHROPIC_BASE_URL (same as tap.js)
    try:
        settings_path = pathlib.Path.home() / ".claude" / "settings.json"
        settings = json.loads(settings_path.read_text())
        url = settings.get("env", {}).get("ANTHROPIC_BASE_URL")
        if url:
            return url.rstrip("/")
    except Exception:
        pass
    # 3. Default
    return "https://api.anthropic.com"

UPSTREAM_URL = _resolve_upstream_url()
logger.info("PII proxy upstream: %s", UPSTREAM_URL)
ENTITY_TYPES = [
    e.strip()
    for e in os.getenv(
        "PII_PROXY_ENTITIES",
        "PASSWORD",
    ).split(",")
]

# AES-256 key stored as 64-char hex; auto-generate if absent
_key_hex = os.getenv("PII_PROXY_AES_KEY", "")
if len(_key_hex) == 64:
    try:
        AES_KEY = bytes.fromhex(_key_hex)
    except ValueError:
        logger.warning("PII_PROXY_AES_KEY contains invalid hex; generating new key")
        AES_KEY = secrets.token_bytes(32)
        logger.info("Generated AES key (set PII_PROXY_AES_KEY=%s to persist)", AES_KEY.hex())
else:
    AES_KEY = secrets.token_bytes(32)
    logger.info("Generated AES key (set PII_PROXY_AES_KEY=%s to persist)", AES_KEY.hex())

# ---------------------------------------------------------------------------
# In-memory log buffer (last 200 diff entries for the debug UI)
# ---------------------------------------------------------------------------

_log_buffer: deque = deque(maxlen=200)

# ---------------------------------------------------------------------------
# PII groups: keyed by deterministic encrypted token, tracks all occurrences
# ---------------------------------------------------------------------------

_pii_groups: dict = {}  # token_key → {entity_type, masked, hits: deque}
_MAX_PII_GROUPS = 200

_TAG_EXTRACT_RE = re.compile(r"<PII:([A-Z_]+)>([^<]+)</PII>")


def _mask_value(s: str) -> str:
    if len(s) <= 2:
        return "****"
    if len(s) <= 6:
        return s[0] + "***" + s[-1]
    return s[:2] + "****" + s[-2:]


def _record_pii_hits(after: str, req_id: str, ts: str, label: str) -> None:
    for m in _TAG_EXTRACT_RE.finditer(after):
        entity_type = m.group(1)
        encrypted = m.group(2)
        token_key = encrypted  # deterministic: same plaintext → same ciphertext
        if token_key not in _pii_groups:
            if len(_pii_groups) >= _MAX_PII_GROUPS:
                oldest = next(iter(_pii_groups))
                del _pii_groups[oldest]
            try:
                original = _decrypt(encrypted)
                masked = _mask_value(original)
            except Exception:
                masked = "****"
            _pii_groups[token_key] = {
                "entity_type": entity_type,
                "masked": masked,
                "hits": deque(maxlen=200),
            }
        _pii_groups[token_key]["hits"].appendleft({"req_id": req_id, "ts": ts, "label": label})

# ---------------------------------------------------------------------------
# Diff logging helper
# ---------------------------------------------------------------------------

def _log_diff(req_id: str, label: str, before: str, after: str) -> None:
    if before == after:
        return
    ts = datetime.now(timezone.utc).isoformat()
    _record_pii_hits(after, req_id, ts, label)
    diff = list(difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"a/{label}",
        tofile=f"b/{label}",
        lineterm="",
    ))
    if diff:
        diff_text = "\n".join(diff)
        logger.info("[%s] %s\n%s", req_id, label, diff_text)
        _log_buffer.append({
            "id": req_id,
            "ts": ts,
            "label": label,
            "diff": diff_text,
        })

# ---------------------------------------------------------------------------
# AES-CBC helpers
# ---------------------------------------------------------------------------

def _encrypt(plaintext: str) -> str:
    # Deterministic IV: HMAC-SHA256(key, plaintext)[:16]，相同内容产生相同密文
    iv = hmac.new(AES_KEY, plaintext.encode(), hashlib.sha256).digest()[:16]
    padder = crypto_padding.PKCS7(128).padder()
    padded = padder.update(plaintext.encode()) + padder.finalize()
    cipher = Cipher(algorithms.AES(AES_KEY), modes.CBC(iv), backend=default_backend())
    enc = cipher.encryptor()
    ct = enc.update(padded) + enc.finalize()
    return base64.b64encode(iv + ct).decode()


def _decrypt(b64data: str) -> str:
    raw = base64.b64decode(b64data)
    iv, ct = raw[:16], raw[16:]
    cipher = Cipher(algorithms.AES(AES_KEY), modes.CBC(iv), backend=default_backend())
    dec = cipher.decryptor()
    padded = dec.update(ct) + dec.finalize()
    unpadder = crypto_padding.PKCS7(128).unpadder()
    return (unpadder.update(padded) + unpadder.finalize()).decode()

# ---------------------------------------------------------------------------
# PII anonymize / deanonymize
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<PII:[A-Z_]+>[^<]+</PII>")


class PasswordValueRecognizer(EntityRecognizer):
    """Detects password values in structured and natural-language text.

    Returns the span of the VALUE only (not the keyword), so JSON keys like
    "password" survive intact after anonymization.

    Covered patterns:
      - Structured:  password=secret  /  "password": "secret"  /  PASSWORD=secret
      - Natural (EN): my password is secret / password is: secret
      - Natural (ZH): 密码是 secret / 口令为 secret
    """

    SUPPORTED_ENTITIES = ["PASSWORD"]

    # keyword → optional closing quote → separator → VALUE (group 1/2/3)
    _STRUCTURED = re.compile(
        r"""(?ix)
        (?:password|passwd|pwd|pass|secret|
           api[_\-]?key|auth[_\-]?token|access[_\-]?token|
           private[_\-]?key|db[_\-]?pass(?:word)?|
           密码|口令|暗语)
        \s*["']?\s*[=:]\s*
        (?:"([^"]{4,})"|'([^']{4,})'|([^\s,;\[\]{}()"'<>\n]{4,}))
        """
    )

    _NATURAL_EN = re.compile(
        r"""(?ix)
        (?:my\s+)?(?:password|passwd|secret)\s+(?:is[:\s]|:)\s*
        (?:"([^"]{4,})"|'([^']{4,})'|(\S{4,}))
        """
    )

    _NATURAL_ZH = re.compile(
        r"(?:密码|口令|暗语|密语)\s*(?:是|为|：|:)\s*(\S{4,})"
    )

    def __init__(self):
        super().__init__(
            supported_entities=self.SUPPORTED_ENTITIES,
            supported_language="en",
            name="PasswordValueRecognizer",
        )

    def load(self): pass

    def analyze(self, text: str, entities, nlp_artifacts: NlpArtifacts = None):
        results = []
        for pattern in (self._STRUCTURED, self._NATURAL_EN, self._NATURAL_ZH):
            for m in pattern.finditer(text):
                group_idx = next(
                    (i for i in range(1, (m.lastindex or 0) + 1) if m.group(i)),
                    None,
                )
                if group_idx:
                    start, end = m.span(group_idx)
                    results.append(RecognizerResult("PASSWORD", start, end, score=0.85))
        return results


_nlp_engine = NlpEngineProvider(nlp_configuration={
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
}).create_engine()
_analyzer = AnalyzerEngine(nlp_engine=_nlp_engine)
_analyzer.registry.add_recognizer(PasswordValueRecognizer())


def _scan_secrets(text: str) -> List[RecognizerResult]:
    """用 detect-secrets 扫描文本，逐行定位 secret 偏移量后返回 RecognizerResult 列表。"""
    if not _DS_AVAILABLE or not text:
        return []
    results = []
    offset = 0
    with _ds_transient(_DS_CONFIG):
        for line in text.splitlines(keepends=True):
            for secret in _ds_scan_line(line):
                val = secret.secret_value
                if not val or len(val) < 6:
                    continue
                pos = line.find(val)
                if pos < 0:
                    continue
                start = offset + pos
                end = start + len(val)
                entity = _DS_TYPE_MAP.get(secret.type, "SECRET")
                results.append(RecognizerResult(entity, start, end, score=0.9))
            offset += len(line)
    return results


_PASSWORD_HINT_RE = re.compile(
    r"password|passwd|pwd|pass|secret|api[_\-]?key|auth[_\-]?token|access[_\-]?token|"
    r"private[_\-]?key|db[_\-]?pass|密码|口令|暗语",
    re.IGNORECASE,
)

@lru_cache(maxsize=512)
def anonymize_text(text: str) -> str:
    if not text or not text.strip():
        return text
    # detect-secrets runs unconditionally (JWT/AWS key/PEM have no password keywords)
    results = _scan_secrets(text)
    # presidio NLP: skip if no password-related keywords present
    if _PASSWORD_HINT_RE.search(text):
        results += _analyzer.analyze(text=text, language="en", entities=ENTITY_TYPES)
    if not results:
        return text
    # 去除重叠 span（同起点保留高分，不同起点跳过被覆盖的）
    results.sort(key=lambda r: (r.start, -r.score))
    deduped, last_end = [], -1
    for r in results:
        if r.start >= last_end:
            deduped.append(r)
            last_end = r.end
    # 从右到左替换，保证偏移量正确
    deduped.sort(key=lambda r: r.start, reverse=True)
    chars = list(text)
    for r in deduped:
        encrypted = _encrypt(text[r.start : r.end])
        tag = f"<PII:{r.entity_type}>{encrypted}</PII>"
        chars[r.start : r.end] = list(tag)
    return "".join(chars)


def deanonymize_text(text: str, req_id: str = "", label: str = "") -> str:
    original = text

    def _replace(m: re.Match) -> str:
        inner = m.group(0)
        # Extract base64 payload between > and </PII>
        payload = inner.split(">", 1)[1].rsplit("</PII>", 1)[0]
        try:
            return _decrypt(payload)
        except Exception as exc:
            logger.warning("Failed to decrypt PII tag: %s", exc)
            return inner

    result = _TAG_RE.sub(_replace, text)
    if req_id:
        _log_diff(req_id, label or "response", original, result)
    return result


def _anonymize_messages(messages: list, req_id: str = "") -> tuple:
    out = []
    modified = False
    for i, msg in enumerate(messages):
        msg = dict(msg)
        role = msg.get("role", "?")
        label = f"msg[{i}]({role})"
        content = msg.get("content")
        if isinstance(content, str):
            before = content
            msg["content"] = anonymize_text(content)
            if msg["content"] != before:
                modified = True
                if req_id:
                    _log_diff(req_id, label, before, msg["content"])
        elif isinstance(content, list):
            new_blocks = []
            for j, block in enumerate(content):
                block = dict(block)
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    before = block["text"]
                    block["text"] = anonymize_text(block["text"])
                    if block["text"] != before:
                        modified = True
                        if req_id:
                            _log_diff(req_id, f"{label}/text[{j}]", before, block["text"])
                elif block.get("type") == "tool_result" and isinstance(block.get("content"), list):
                    new_content = []
                    for k, b in enumerate(block["content"]):
                        b = dict(b)
                        if b.get("type") == "text" and isinstance(b.get("text"), str):
                            before = b["text"]
                            b["text"] = anonymize_text(b["text"])
                            if b["text"] != before:
                                modified = True
                                if req_id:
                                    _log_diff(req_id, f"{label}/tool_result[{j}]/text[{k}]", before, b["text"])
                        new_content.append(b)
                    block["content"] = new_content
                new_blocks.append(block)
            msg["content"] = new_blocks
        out.append(msg)
    return out, modified


def _deanonymize_obj(obj, req_id: str = "", path: str = "response"):
    if isinstance(obj, str):
        return deanonymize_text(obj, req_id=req_id, label=path)
    if isinstance(obj, dict):
        return {k: _deanonymize_obj(v, req_id=req_id, path=f"{path}.{k}") for k, v in obj.items()}
    if isinstance(obj, list):
        return [_deanonymize_obj(item, req_id=req_id, path=f"{path}[{i}]") for i, item in enumerate(obj)]
    return obj

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

_client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=30.0, read=None, write=None, pool=None),
    follow_redirects=True,
)

_HOP_BY_HOP = {"host", "content-length", "transfer-encoding", "connection", "keep-alive", "content-encoding"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await _client.aclose()

app = FastAPI(title="PII Proxy", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "upstream": UPSTREAM_URL}


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
    result = []
    for token_key, v in _pii_groups.items():
        hits = list(v["hits"])
        result.append({
            "token_key": token_key[:16],
            "entity_type": v["entity_type"],
            "masked": v["masked"],
            "count": len(hits),
            "last_seen": hits[0]["ts"] if hits else "",
            "occurrences": hits,
        })
    result.sort(key=lambda x: x["last_seen"], reverse=True)
    return {"groups": result}


@app.delete("/pii-groups")
async def clear_pii_groups():
    _pii_groups.clear()
    return {"ok": True}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy(request: Request, path: str):
    _t0 = time.monotonic()
    body = await request.body()
    req_id = uuid.uuid4().hex[:8]

    # Anonymize PII in POST /v1/messages
    _t_anon = time.monotonic()
    if request.method == "POST" and path == "v1/messages":
        try:
            data = json.loads(body)
            modified = False
            loop = asyncio.get_running_loop()
            if "messages" in data:
                data["messages"], msg_modified = await loop.run_in_executor(
                    None, _anonymize_messages, data["messages"], req_id
                )
                modified = modified or msg_modified
            if isinstance(data.get("system"), str):
                before = data["system"]
                data["system"] = await loop.run_in_executor(None, anonymize_text, before)
                if data["system"] != before:
                    _log_diff(req_id, "system", before, data["system"])
                    modified = True
            if modified:
                body = json.dumps(data).encode()
        except Exception as exc:
            logger.warning("Failed to anonymize request: %s", exc)
    _anon_ms = (time.monotonic() - _t_anon) * 1000

    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}
    upstream_url = f"{UPSTREAM_URL}/{path}"
    if request.url.query:
        upstream_url += f"?{request.url.query}"

    last_exc = None
    for attempt in range(4):
        if attempt:
            wait = 2 ** (attempt - 1)  # 1s, 2s, 4s
            logger.warning("[%s] retry %d/3 after %.0fs (reason: %s)", req_id, attempt, wait, last_exc)
            await asyncio.sleep(wait)
        req = _client.build_request(
            method=request.method,
            url=upstream_url,
            headers=fwd_headers,
            content=body,
        )
        try:
            upstream_resp = await _client.send(req, stream=True)
            break
        except httpx.TransportError as exc:
            last_exc = exc
    else:
        raise last_exc

    content_type = upstream_resp.headers.get("content-type", "")
    resp_headers = {k: v for k, v in upstream_resp.headers.items() if k.lower() not in _HOP_BY_HOP}

    # SSE: stream with deanonymize, buffering across chunk boundaries
    if "text/event-stream" in content_type:
        _ttfb = time.monotonic() - _t0
        logger.info("[%s] %s %s → %d (SSE) anon=%.0fms ttfb=%.3fs", req_id, request.method, path, upstream_resp.status_code, _anon_ms, _ttfb)
        async def _stream():
            raw_buf = bytearray()
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            text_buf = ""
            try:
                async for chunk in upstream_resp.aiter_bytes():
                    raw_buf += chunk
                    # Decode only complete UTF-8 sequences; incomplete tail stays in raw_buf
                    decoded = decoder.decode(chunk, final=False)
                    text_buf += decoded
                    last_open = text_buf.rfind("<PII:")
                    if last_open != -1 and "</PII>" not in text_buf[last_open:]:
                        # Incomplete PII tag — hold it back
                        safe, text_buf = text_buf[:last_open], text_buf[last_open:]
                    else:
                        safe, text_buf = text_buf, ""
                    if safe:
                        yield deanonymize_text(safe).encode("utf-8")
            finally:
                # Flush remaining with final=True to emit any replacement chars
                tail = decoder.decode(b"", final=True)
                text_buf += tail
                if text_buf:
                    yield deanonymize_text(text_buf).encode("utf-8")
                await upstream_resp.aclose()
        return StreamingResponse(_stream(), status_code=upstream_resp.status_code, headers=resp_headers)

    # Non-streaming: load full response then deanonymize
    try:
        await upstream_resp.aread()
        resp_body = upstream_resp.content
        if "application/json" in content_type:
            try:
                resp_data = json.loads(resp_body)
                resp_data = _deanonymize_obj(resp_data, req_id=req_id)
                resp_body = json.dumps(resp_data).encode()
            except Exception as exc:
                logger.warning("Failed to deanonymize response: %s", exc)
    finally:
        await upstream_resp.aclose()
    logger.info("[%s] %s %s → %d anon=%.0fms total=%.3fs", req_id, request.method, path, upstream_resp.status_code, _anon_ms, time.monotonic() - _t0)
    resp_headers["content-length"] = str(len(resp_body))
    return Response(
        content=resp_body,
        status_code=upstream_resp.status_code,
        headers=resp_headers,
    )
