"""Real end-to-end HTTP tests for PII proxy v2 (issue #24 hardening).

Unlike test_proxy_v2.py (FastAPI TestClient + a mocked httpx.send) these tests
exercise the real network path:

* a real http.server fake upstream, on a random port in 189xx;
* a real uvicorn subprocess running pii_proxy:app, on 1812x;
* real HTTP requests made with httpx.

Nothing is mocked.  The body the fake upstream records is the exact bytes the
proxy forwarded, and the bytes the client reads are the exact bytes the proxy
returned, so every assertion below is about observable wire behaviour.

Scenarios covered (issue #24):

1. process wiring / health;
2. three-turn conversation with stable aliases;
3. SSE split byte-by-byte, randomly, and inside an alias;
4. tool-call loop (input_json_delta shards + content_block_stop);
5. secrets containing quotes / backslashes / newlines / CJK / emoji;
6. upstream 500 JSON error, text/plain passthrough, invalid request body,
   count_tokens redaction;
7. observability endpoints (/health, /logs, /pii-groups and their DELETEs);
8. eight concurrent requests never leak plaintext upstream.

The fixture is module scoped on purpose: starting uvicorn once keeps the whole
suite under a few seconds while still being a real subprocess with its own
vault/secrets/HOME under a temp directory.
"""

from __future__ import annotations

import http.server
import json
import os
import pathlib
import random
import re
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import httpx
import pytest

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

PII_PROXY_DIR = pathlib.Path(__file__).resolve().parents[1]

#: Backslash and newline, spelled without escape sequences so this file has no
#: backslashes at all (keeps it copy/paste and diff safe).
BS = chr(92)
LF = chr(10)

#: Canonical alias shape (same grammar as pii_vault.ALIAS_RX).
ALIAS_RX = re.compile(r"PII_[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_[0-9a-f]{6,16}")

#: Literal secret with a double quote and a backslash (the D1 trigger).
PASSWORD = 'pa"ss' + BS + "word-1234"
#: Literal secret with quotes, backslash, newline, CJK and an emoji.
SPECIAL = '秘"密' + BS + "路径" + LF + "emoji😀-end"

SECRETS = {
    "literals": [
        {"kind": "PASSWORD", "value": PASSWORD},
        {"kind": "SPECIAL", "value": SPECIAL},
    ],
    "patterns": [],
    "case_sensitive": False,
    "min_literal_len": 4,
}

UPSTREAM_PORT_RANGE = (18900, 18999)
PROXY_PORT_RANGE = (18120, 18129)


# --------------------------------------------------------------------------- #
# Fake upstream (real TCP server)
# --------------------------------------------------------------------------- #


@dataclass
class Reply:
    """A canned upstream response.

    chunks (when given) is written to the socket one piece at a time with a
    flush in between; body is then ignored and the concatenation of the chunks
    is used for Content-Length.  This is what lets a test force an SSE response
    to arrive in arbitrary transport-level splits.
    """

    status: int = 200
    content_type: str = "application/json"
    body: bytes = b'{"content": []}'
    chunks: list | None = None
    chunk_delay: float = 0.0


class FakeUpstream:
    """Thread-safe recorder + programmable responder for the fake upstream."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests: list = []
        self.responder = None  # callable(method, path, headers, body) -> Reply

    def reset(self) -> None:
        with self._lock:
            self.requests = []
            self.responder = None

    def record(self, method: str, path: str, headers: dict, body: bytes) -> None:
        with self._lock:
            self.requests.append(
                {"method": method, "path": path, "headers": headers, "body": body}
            )

    def reply_for(self, method: str, path: str, headers: dict, body: bytes) -> Reply:
        with self._lock:
            responder = self.responder
        if responder is None:
            return Reply()
        return responder(method, path, headers, body)

    # -- convenience helpers used by the tests -----------------------------

    def last_body(self) -> bytes:
        with self._lock:
            assert self.requests, "upstream never received a request"
            return self.requests[-1]["body"]

    def last_text(self) -> str:
        return self.last_body().decode("utf-8")

    def bodies(self) -> list:
        with self._lock:
            return [request["body"] for request in self.requests]


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Without TCP_NODELAY, Nagle + delayed ACK can serialise the one-byte SSE
    # writes below at ~40ms each, turning a fast test into a 10s one.
    disable_nagle_algorithm = True

    def log_message(self, *args) -> None:  # silence test output
        pass

    def _handle(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        fake: FakeUpstream = self.server.fake
        fake.record(self.command, self.path, dict(self.headers), body)
        reply = fake.reply_for(self.command, self.path, dict(self.headers), body)

        payload = b"".join(reply.chunks) if reply.chunks is not None else reply.body
        self.send_response(reply.status)
        self.send_header("Content-Type", reply.content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        if reply.chunks is not None:
            for chunk in reply.chunks:
                if chunk:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                if reply.chunk_delay:
                    time.sleep(reply.chunk_delay)
        else:
            self.wfile.write(payload)
            self.wfile.flush()
        self.close_connection = True

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_DELETE = _handle
    do_PATCH = _handle


# --------------------------------------------------------------------------- #
# Live stack fixtures
# --------------------------------------------------------------------------- #


@dataclass
class LiveProxy:
    base_url: str
    upstream_url: str
    upstream: FakeUpstream
    process: subprocess.Popen
    root: pathlib.Path
    vault_path: pathlib.Path
    secrets_path: pathlib.Path
    log_path: pathlib.Path


def _free_port(lo: int, hi: int) -> int:
    rng = random.SystemRandom()
    for _ in range(200):
        port = rng.randint(lo, hi)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise RuntimeError("no free port in %d..%d" % (lo, hi))


def _start_upstream():
    fake = FakeUpstream()
    port = _free_port(*UPSTREAM_PORT_RANGE)
    server = _Server(("127.0.0.1", port), _Handler)
    server.fake = fake
    threading.Thread(target=server.serve_forever, name="fake-upstream", daemon=True).start()
    return server, fake, port


def _read_log(path: pathlib.Path) -> str:
    try:
        return path.read_text("utf-8", errors="replace")
    except Exception:
        return "<no log>"


def _wait_for_health(base_url: str, process: subprocess.Popen, log_path: pathlib.Path, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                "uvicorn exited with %r before becoming healthy; log:%s%s"
                % (process.returncode, LF, _read_log(log_path))
            )
        try:
            response = httpx.get(base_url + "/health", timeout=1.0)
            if response.status_code == 200:
                return
            last_error = RuntimeError("health returned %d" % response.status_code)
        except Exception as exc:  # connection refused while uvicorn boots
            last_error = exc
        time.sleep(0.05)
    raise RuntimeError(
        "proxy did not become healthy in %.1fs: %r%s%s" % (timeout, last_error, LF, _read_log(log_path))
    )


@pytest.fixture(scope="module")
def live_proxy(tmp_path_factory):
    root = tmp_path_factory.mktemp("pii-proxy-http-e2e")
    secrets_path = root / "secrets.json"
    secrets_path.write_text(json.dumps(SECRETS, ensure_ascii=False), "utf-8")
    vault_path = root / "vault.json"

    upstream_server, upstream, upstream_port = _start_upstream()
    upstream_url = "http://127.0.0.1:%d" % upstream_port

    proxy_port = _free_port(*PROXY_PORT_RANGE)
    base_url = "http://127.0.0.1:%d" % proxy_port
    env = os.environ.copy()
    env.update(
        {
            # The proxy reads these at import time, so they must be real env
            # vars of the subprocess (not monkeypatched module globals).
            "PII_PROXY_UPSTREAM_URL": upstream_url,
            "PII_PROXY_SECRETS_FILE": str(secrets_path),
            "PII_PROXY_VAULT_FILE": str(vault_path),
            "HOME": str(root),
        }
    )
    log_path = root / "proxy.log"
    log_file = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "pii_proxy:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(proxy_port),
            "--log-level",
            "warning",
        ],
        cwd=str(PII_PROXY_DIR),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )

    try:
        _wait_for_health(base_url, process, log_path)
        live = LiveProxy(
            base_url=base_url,
            upstream_url=upstream_url,
            upstream=upstream,
            process=process,
            root=root,
            vault_path=vault_path,
            secrets_path=secrets_path,
            log_path=log_path,
        )
        yield live
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        upstream_server.shutdown()
        upstream_server.server_close()
        log_file.close()


@pytest.fixture()
def upstream(live_proxy):
    live_proxy.upstream.reset()
    yield live_proxy.upstream
    live_proxy.upstream.reset()


@pytest.fixture()
def client(live_proxy):
    with httpx.Client(base_url=live_proxy.base_url, timeout=20.0) as http:
        yield http


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _sse(*events: dict) -> bytes:
    sep = (LF + LF).encode("utf-8")
    return b"".join(b"data: " + json.dumps(event).encode("utf-8") + sep for event in events)


def _data_frames(text: str) -> list:
    """Parse every data: frame of an SSE response as JSON."""
    frames = []
    for line in text.split(LF):
        if not line.startswith("data: "):
            continue
        frames.append(json.loads(line[6:]))  # raises if the frame is not JSON
    return frames


def _text_of(frames: list) -> str:
    out = []
    for frame in frames:
        delta = frame.get("delta") or {}
        if frame.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
            out.append(delta.get("text", ""))
    return "".join(out)


def _input_json(frames: list) -> str:
    out = []
    for frame in frames:
        delta = frame.get("delta") or {}
        if frame.get("type") == "content_block_delta" and delta.get("type") == "input_json_delta":
            out.append(delta.get("partial_json", ""))
    return "".join(out)


def _alias_of(text: str) -> str:
    match = ALIAS_RX.search(text)
    assert match is not None, "no alias in %r" % text
    return match.group(0)


def _prime_alias(client: httpx.Client, upstream: FakeUpstream) -> str:
    """Send one request with the plaintext secret and return the minted alias."""
    upstream.responder = None
    response = client.post(
        "/v1/messages",
        json={"model": "m", "messages": [{"role": "user", "content": "prime " + PASSWORD}]},
    )
    assert response.status_code == 200
    return _alias_of(upstream.last_text())


def _split(data: bytes, strategy: str, alias: str = "") -> list:
    if strategy == "single":
        return [data]
    if strategy == "one_byte":
        return [data[i : i + 1] for i in range(len(data))]
    if strategy == "random":
        rng = random.Random(20261101)
        chunks = []
        i = 0
        while i < len(data):
            size = rng.randint(1, 5)
            chunks.append(data[i : i + size])
            i += size
        return chunks
    if strategy == "alias_split":
        needle = alias.encode("utf-8")
        pos = data.index(needle)
        span = len(needle)
        cuts = sorted({0, pos + 1, pos + 2, pos + span // 2, pos + span - 1, len(data)})
        cuts = [cut for cut in cuts if 0 <= cut <= len(data)]
        return [data[a:b] for a, b in zip(cuts, cuts[1:]) if b > a]
    raise AssertionError("unknown split strategy %r" % strategy)


def _sse_text_stream(text: str) -> bytes:
    """SSE response whose single text block carries text."""
    return _sse(
        {"type": "message_start", "message": {"id": "msg_e2e", "type": "message", "role": "assistant"}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_stop"},
    )


# --------------------------------------------------------------------------- #
# 1. Wiring / health
# --------------------------------------------------------------------------- #


def test_health_reports_real_wiring(live_proxy) -> None:
    body = httpx.get(live_proxy.base_url + "/health", timeout=5.0).json()
    assert body["status"] == "ok"
    assert body["mode"] == "v2-aliases"
    # The subprocess really did pick up PII_PROXY_UPSTREAM_URL.
    assert body["upstream"] == live_proxy.upstream_url
    for key in ("detector", "vault", "stats"):
        assert isinstance(body[key], dict), key
    assert body["detector"]["literals"] >= 2
    assert body["detector"]["patterns"] >= 1
    assert body["vault"]["path"] == str(live_proxy.vault_path)
    assert body["vault"]["persistent"] is True
    assert set(body["stats"]) >= {
        "requests",
        "anonymized_values",
        "restored_values",
        "uncovered_binary",
        "signed_blocks_skipped",
    }


# --------------------------------------------------------------------------- #
# 2. Multi-turn conversation: aliases are stable across turns
# --------------------------------------------------------------------------- #


def test_multi_turn_aliases_stable(client: httpx.Client, upstream: FakeUpstream) -> None:
    def echo_aliases(method, path, headers, body):
        aliases = sorted(set(ALIAS_RX.findall(body.decode("utf-8", "replace"))))
        text = "round ok " + " ".join(aliases)
        return Reply(body=json.dumps({"content": [{"type": "text", "text": text}]}).encode())

    upstream.responder = echo_aliases

    # -- turn 1: plaintext goes up, alias comes back down -------------------
    r1 = client.post(
        "/v1/messages",
        json={"model": "m", "messages": [{"role": "user", "content": "the login is " + PASSWORD}]},
    )
    assert r1.status_code == 200
    forwarded1 = upstream.last_text()
    assert PASSWORD not in forwarded1
    alias = _alias_of(forwarded1)
    assert alias not in r1.text
    assert json.loads(r1.text)["content"][0]["text"] == "round ok " + PASSWORD

    # -- turn 2: history carries the redacted text and a tool result --------
    r2 = client.post(
        "/v1/messages",
        json={
            "model": "m",
            "messages": [
                {"role": "user", "content": "the login is " + PASSWORD},
                {"role": "assistant", "content": "round ok " + alias},
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "t1", "content": "tool saw " + PASSWORD}
                    ],
                },
            ],
        },
    )
    assert r2.status_code == 200
    forwarded2 = upstream.last_text()
    assert PASSWORD not in forwarded2
    # Same true value -> same alias, even though it arrives as plaintext again.
    assert set(ALIAS_RX.findall(forwarded2)) == {alias}
    assert alias not in r2.text
    assert json.loads(r2.text)["content"][0]["text"] == "round ok " + PASSWORD

    # -- turn 3: several occurrences, still one stable alias ----------------
    r3 = client.post(
        "/v1/messages",
        json={
            "model": "m",
            "messages": [
                {"role": "user", "content": "again " + PASSWORD + " and " + PASSWORD},
                {"role": "assistant", "content": [{"type": "text", "text": "kept " + alias}]},
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "t2", "content": [{"type": "text", "text": PASSWORD}]}
                    ],
                },
            ],
        },
    )
    assert r3.status_code == 200
    forwarded3 = upstream.last_text()
    assert PASSWORD not in forwarded3
    assert set(ALIAS_RX.findall(forwarded3)) == {alias}
    assert forwarded3.count(alias) >= 3
    assert alias not in r3.text
    assert json.loads(r3.text)["content"][0]["text"] == "round ok " + PASSWORD


# --------------------------------------------------------------------------- #
# 3. SSE arrived in extreme transport splits
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("strategy", ["single", "one_byte", "random", "alias_split"])
def test_sse_extreme_splitting(client: httpx.Client, upstream: FakeUpstream, strategy: str) -> None:
    alias = _prime_alias(client, upstream)
    text = "secret: " + alias + " ::done"
    expected = "secret: " + PASSWORD + " ::done"

    def run_split(split_strategy: str):
        raw = _sse_text_stream(text)
        chunks = _split(raw, split_strategy, alias)

        def respond(method, path, headers, body):
            return Reply(status=200, content_type="text/event-stream", chunks=chunks)

        upstream.responder = respond
        response = client.post("/v1/messages", json={"model": "m", "messages": []})
        assert response.status_code == 200
        assert "text/event-stream" in response.headers.get("content-type", "")
        # Every data: frame must be valid JSON (json.loads raises otherwise).
        frames = _data_frames(response.text)
        assert frames, "no SSE frames returned"
        assert alias not in response.text, "raw alias leaked into the client stream"
        return _text_of(frames)

    baseline = run_split("single")
    variant = run_split(strategy)
    assert baseline == expected
    assert variant == baseline


# --------------------------------------------------------------------------- #
# 4. Tool-call closed loop: input_json_delta shards + content_block_stop
# --------------------------------------------------------------------------- #


def test_tool_call_input_json_is_restored(client: httpx.Client, upstream: FakeUpstream) -> None:
    alias = _prime_alias(client, upstream)

    tool_input = {
        "path": "/tmp/out.txt",
        "token": alias,
        "nested": {"levels": [1, {"v": alias}], "flag": True},
        "note": "plain",
    }
    raw_json = json.dumps(tool_input)
    pos = raw_json.index(alias)
    cuts = sorted({0, pos + 1, pos + 2, pos + 3, len(raw_json)})
    pieces = [raw_json[a:b] for a, b in zip(cuts, cuts[1:]) if b > a]
    assert len(pieces) >= 4

    def respond_tool(method, path, headers, body):
        events = [
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "toolu_e2e", "name": "write_secret", "input": {}},
            },
        ]
        for piece in pieces:
            events.append(
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": piece},
                }
            )
        events.append({"type": "content_block_stop", "index": 0})
        events.append({"type": "message_stop"})
        return Reply(status=200, content_type="text/event-stream", body=_sse(*events))

    upstream.responder = respond_tool
    request_payload = {
        "model": "m",
        "messages": [
            {"role": "user", "content": "call the tool with " + PASSWORD},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "write_secret",
                        "input": {"path": "/tmp/x", "meta": {"nested": ["deep " + PASSWORD]}},
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "stored " + PASSWORD}
                ],
            },
        ],
    }
    response = client.post("/v1/messages", json=request_payload)
    assert response.status_code == 200

    # The request upstream saw is fully anonymised, tool_use / result included.
    forwarded = upstream.last_text()
    assert PASSWORD not in forwarded
    assert forwarded.count(alias) >= 3
    for block in json.loads(forwarded)["messages"]:
        assert PASSWORD not in json.dumps(block)

    frames = _data_frames(response.text)
    deltas = [
        frame
        for frame in frames
        if frame.get("type") == "content_block_delta"
        and (frame.get("delta") or {}).get("type") == "input_json_delta"
    ]
    stops = [frame for frame in frames if frame.get("type") == "content_block_stop"]
    assert len(deltas) == len(pieces), "proxy must keep the upstream frame count"
    assert len(stops) == 1
    assert frames.index(stops[0]) == len(frames) - 2  # stop just before message_stop

    merged = _input_json(frames)
    assert alias not in merged
    restored = json.loads(merged)
    assert restored["token"] == PASSWORD
    assert restored["nested"]["levels"][1]["v"] == PASSWORD
    assert restored["nested"]["flag"] is True
    assert restored["path"] == "/tmp/out.txt"


# --------------------------------------------------------------------------- #
# 5. Secrets containing quotes, backslashes, newlines, CJK, emoji
# --------------------------------------------------------------------------- #


def test_special_characters_survive_sse(client: httpx.Client, upstream: FakeUpstream) -> None:
    def respond_special(method, path, headers, body):
        aliases = ALIAS_RX.findall(body.decode("utf-8", "replace"))
        assert aliases, "request was not anonymised"
        text = "value=[" + aliases[0] + "]"
        raw = _sse_text_stream(text)
        return Reply(
            status=200,
            content_type="text/event-stream",
            chunks=_split(raw, "alias_split", aliases[0]),
        )

    upstream.responder = respond_special
    response = client.post(
        "/v1/messages",
        json={"model": "m", "messages": [{"role": "user", "content": "carry " + SPECIAL}]},
    )
    assert response.status_code == 200

    forwarded = upstream.last_text()
    assert SPECIAL not in forwarded
    alias = _alias_of(forwarded)

    frames = _data_frames(response.text)  # every frame must parse
    assert alias not in response.text
    result = _text_of(frames)
    assert result == "value=[" + SPECIAL + "]"
    # Prove each awkward character survived: quote, backslash, newline, CJK, emoji.
    assert '"' in result
    assert BS in result
    assert LF in result
    assert "秘" in result
    assert "😀" in result


# --------------------------------------------------------------------------- #
# 6. Boundaries and errors
# --------------------------------------------------------------------------- #


def test_upstream_500_json_error_is_restored(client: httpx.Client, upstream: FakeUpstream) -> None:
    def respond_error(method, path, headers, body):
        alias = _alias_of(body.decode("utf-8", "replace"))
        payload = {
            "type": "error",
            "error": {"type": "api_error", "message": "boom for " + alias},
        }
        return Reply(status=500, content_type="application/json", body=json.dumps(payload).encode())

    upstream.responder = respond_error
    response = client.post(
        "/v1/messages",
        json={"model": "m", "messages": [{"role": "user", "content": "bad " + PASSWORD}]},
    )
    alias = _alias_of(upstream.last_text())
    assert response.status_code == 500
    assert alias not in response.text
    assert json.loads(response.text)["error"]["message"] == "boom for " + PASSWORD


def test_text_plain_is_passed_through_verbatim(client: httpx.Client, upstream: FakeUpstream) -> None:
    def respond_plain(method, path, headers, body):
        alias = _alias_of(body.decode("utf-8", "replace"))
        return Reply(
            status=200,
            content_type="text/plain; charset=utf-8",
            body=("plain " + alias).encode("utf-8"),
        )

    upstream.responder = respond_plain
    response = client.post(
        "/v1/messages",
        json={"model": "m", "messages": [{"role": "user", "content": "plain " + PASSWORD}]},
    )
    alias = _alias_of(upstream.last_text())
    assert response.status_code == 200
    # text/plain is not JSON, so the proxy must not rewrite it.
    assert response.text == "plain " + alias
    assert PASSWORD not in response.text


def test_invalid_request_json_is_forwarded_and_never_500s(client: httpx.Client, upstream: FakeUpstream) -> None:
    raw = b'{"messages": [ this is not valid json '
    upstream.responder = None
    response = client.post(
        "/v1/messages",
        content=raw,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 200
    assert upstream.last_body() == raw  # fail-open, byte identical


def test_count_tokens_is_anonymized(client: httpx.Client, upstream: FakeUpstream) -> None:
    upstream.responder = None
    response = client.post(
        "/v1/messages/count_tokens",
        json={"model": "m", "messages": [{"role": "user", "content": "count " + PASSWORD}]},
    )
    assert response.status_code == 200
    forwarded = upstream.last_text()
    assert PASSWORD not in forwarded
    assert ALIAS_RX.search(forwarded) is not None
    assert upstream.requests[-1]["path"].endswith("/v1/messages/count_tokens")


# --------------------------------------------------------------------------- #
# 7. Observability endpoints (settings-UI compatible shapes)
# --------------------------------------------------------------------------- #


def test_observability_endpoints(client: httpx.Client, upstream: FakeUpstream) -> None:
    upstream.responder = None
    assert client.delete("/logs").json() == {"ok": True}
    assert client.delete("/pii-groups").json() == {"ok": True}

    assert (
        client.post(
            "/v1/messages",
            json={"model": "m", "messages": [{"role": "user", "content": "observe " + PASSWORD}]},
        ).status_code
        == 200
    )

    health = client.get("/health").json()
    assert health["status"] == "ok"
    assert health["stats"]["requests"] >= 1
    assert health["stats"]["anonymized_values"] >= 1
    assert health["detector"]["literals"] >= 2
    assert health["detector"]["max_len"] >= 1
    assert isinstance(health["detector"]["issues"], list)

    logs = client.get("/logs").json()
    assert set(logs) == {"entries"}
    assert logs["entries"], "expected at least one diff entry"
    entry = logs["entries"][0]
    assert {"id", "ts", "label", "diff"} <= set(entry)
    assert entry["label"].startswith("request")
    assert ALIAS_RX.search(entry["diff"]) is not None

    groups = client.get("/pii-groups").json()
    assert set(groups) == {"groups"}
    assert groups["groups"], "expected at least one PII group"
    group = groups["groups"][0]
    assert {"token_key", "entity_type", "masked", "count", "last_seen", "occurrences"} <= set(group)
    assert group["token_key"].startswith("PII_")
    assert group["count"] >= 1
    assert "*" in group["masked"]
    assert isinstance(group["occurrences"], list) and group["occurrences"]
    assert {"req_id", "ts", "label"} <= set(group["occurrences"][0])

    assert client.delete("/logs").json() == {"ok": True}
    assert client.get("/logs").json() == {"entries": []}
    assert client.delete("/pii-groups").json() == {"ok": True}
    assert client.get("/pii-groups").json() == {"groups": []}


# --------------------------------------------------------------------------- #
# 8. Concurrency: eight in-flight requests never leak plaintext
# --------------------------------------------------------------------------- #


def test_eight_concurrent_requests_never_leak(client: httpx.Client, upstream: FakeUpstream) -> None:
    upstream.reset()

    def respond(method, path, headers, body):
        time.sleep(0.01)  # keep all eight requests in flight together
        return Reply(body=json.dumps({"content": [{"type": "text", "text": "ok"}]}).encode())

    upstream.responder = respond

    def call(index: int) -> int:
        response = client.post(
            "/v1/messages",
            json={
                "model": "m",
                "messages": [{"role": "user", "content": "job %d uses %s" % (index, PASSWORD)}],
            },
        )
        return response.status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(call, range(8)))

    assert statuses == [200] * 8
    bodies = upstream.bodies()
    assert len(bodies) == 8
    for body in bodies:
        text = body.decode("utf-8")
        assert PASSWORD not in text
        assert ALIAS_RX.search(text) is not None
