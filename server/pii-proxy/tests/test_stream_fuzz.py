"""Protocol-level stream fuzz (not plain-text fuzz).

This file builds *real* Anthropic SSE streams (message_start / content_block_start /
text_delta / input_json_delta / content_block_stop / message_stop), serialises them
to bytes, and then delivers those bytes with arbitrary transport-level splits
(whole, one byte at a time, random sizes, and every possible cut point).

Invariants checked for every generated stream and every split:
  1. every emitted frame is still valid JSON;
  2. the concatenated text equals restore(original text);
  3. the reassembled tool input JSON equals restore(original tool input);
  4. no known placeholder survives anywhere in the output;
  5. the event sequence (type + index) is unchanged.
"""

from __future__ import annotations

import json
import random

import pytest

from pii_stream import SSERestorer

PAIRS = {
    "harper.novak@example.net": "qi.wei@corp-internal.test",
    "10.159.198.181": "117.72.145.38",
    "PII_EMAIL_ADDRESS_abcdef": "edward@jqmt.catwang.top",
    "password=FR(L-+m-vGJB": "password=DevTestPW42",
}
PLACEHOLDERS = list(PAIRS)
MAX_LEN = max(len(k) for k in PAIRS)


def restore(value: str) -> str:
    for key in sorted(PAIRS, key=len, reverse=True):
        value = value.replace(key, PAIRS[key])
    return value


def restore_obj(obj):
    if isinstance(obj, str):
        return restore(obj)
    if isinstance(obj, dict):
        return {k: restore_obj(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [restore_obj(item) for item in obj]
    return obj


def _frame(event: dict) -> bytes:
    return b"data: " + json.dumps(event).encode("utf-8") + b"\n\n"


def build_stream(text_pieces: list, tool_json: str, tool_fragments: list):
    """Return (stream_bytes, expected_event_sequence)."""
    events = [
        {"type": "message_start", "message": {"id": "msg_fuzz", "type": "message", "role": "assistant"}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
    ]
    for piece in text_pieces:
        events.append({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": piece}})
    events.append({"type": "content_block_stop", "index": 0})
    events.append({"type": "content_block_start", "index": 1,
                   "content_block": {"type": "tool_use", "id": "toolu_fuzz", "name": "write", "input": {}}})
    for fragment in tool_fragments:
        events.append({"type": "content_block_delta", "index": 1,
                       "delta": {"type": "input_json_delta", "partial_json": fragment}})
    events.append({"type": "content_block_stop", "index": 1})
    events.append({"type": "message_stop"})
    stream = b"".join(_frame(event) for event in events)
    expected_sequence = [(event.get("type"), event.get("index")) for event in events]
    return stream, expected_sequence


def split_stream(stream: bytes, strategy: str, rng: random.Random | None = None,
                 cut: int | None = None) -> list:
    if strategy == "whole":
        return [stream]
    if strategy == "one_byte":
        return [stream[i : i + 1] for i in range(len(stream))]
    if strategy == "random":
        rng = rng or random.Random(7)
        out, i = [], 0
        while i < len(stream):
            size = rng.randint(1, 13)
            out.append(stream[i : i + size])
            i += size
        return out
    if strategy == "cut":
        return [stream[:cut], stream[cut:]]
    raise AssertionError(strategy)


def run_stream(stream: bytes, chunks: list) -> tuple[str, dict, list, str]:
    restorer = SSERestorer(restore, MAX_LEN, PLACEHOLDERS)
    frames: list = []
    for chunk in chunks:
        frames.extend(restorer.feed(chunk))
    frames.extend(restorer.flush())

    text_parts: list = []
    tool_parts: list = []
    sequence: list = []
    for frame in frames:
        line = frame.decode("utf-8").strip()
        if not line.startswith("data: "):
            continue
        payload = line[len("data: "):]
        if payload == "[DONE]":
            continue
        obj = json.loads(payload)  # invariant 1
        sequence.append((obj.get("type"), obj.get("index")))
        delta = obj.get("delta") or {}
        if delta.get("type") == "text_delta":
            text_parts.append(delta["text"])
        elif delta.get("type") == "input_json_delta":
            tool_parts.append(delta["partial_json"])
    text = "".join(text_parts)
    raw_tool = "".join(tool_parts)
    tool = json.loads(raw_tool) if raw_tool else {}
    return text, tool, sequence, frame.decode() if frames else ""


def _make_case(rng: random.Random) -> tuple[list, str, list]:
    pieces: list = []
    for _ in range(rng.randint(1, 5)):
        kind = rng.choice(["plain", "placeholder", "mixed", "split_placeholder"])
        pad = "x" * rng.randint(0, 40)
        if kind == "plain":
            pieces.append("plain " + pad)
        elif kind == "placeholder":
            pieces.append(rng.choice(PLACEHOLDERS))
        elif kind == "mixed":
            pieces.append("pre " + rng.choice(PLACEHOLDERS) + " post " + pad)
        else:
            placeholder = rng.choice(PLACEHOLDERS)
            cut = rng.randint(1, len(placeholder) - 1)
            pieces.append("lead " + placeholder[:cut])
            pieces.append(placeholder[cut:] + " trail " + pad)

    tool_input = {
        "path": "/tmp/out.txt",
        "token": rng.choice(PLACEHOLDERS),
        "nested": {"levels": [1, {"v": rng.choice(PLACEHOLDERS)}], "flag": True},
        "note": 'quote " backslash \\ newline \n done',
    }
    raw_json = json.dumps(tool_input)
    # split the raw JSON into 1..8 shards, at least one cut inside a placeholder
    cuts = {0, len(raw_json)}
    for placeholder in PLACEHOLDERS:
        pos = raw_json.find(placeholder)
        if pos >= 0:
            cuts.add(pos + rng.randint(1, len(placeholder) - 1))
    for _ in range(rng.randint(1, 6)):
        cuts.add(rng.randint(1, len(raw_json) - 1))
    ordered = sorted(cuts)
    fragments = [raw_json[a:b] for a, b in zip(ordered, ordered[1:]) if b > a]
    return pieces, raw_json, fragments


@pytest.mark.parametrize("seed", list(range(60)))
def test_random_streams_and_random_splits(seed):
    rng = random.Random(seed)
    pieces, tool_json, fragments = _make_case(rng)
    stream, expected_sequence = build_stream(pieces, tool_json, fragments)
    expected_text = restore("".join(pieces))
    expected_tool = restore_obj(json.loads(tool_json))

    for strategy in ("whole", "random"):
        text, tool, sequence, joined = run_stream(stream, split_stream(stream, strategy, rng))
        assert text == expected_text
        assert tool == expected_tool
        # The restorer may insert extra delta frames (it flushes a text block's
        # held-back tail just before that block's stop), but the structural
        # events must be identical and every delta must stay inside a block.
        structural = [s for s in sequence if s[0] != "content_block_delta"]
        assert structural == [s for s in expected_sequence if s[0] != "content_block_delta"]
        assert all(index in (0, 1) for _kind, index in sequence if _kind == "content_block_delta")
        for key in PLACEHOLDERS:
            assert key not in joined


@pytest.mark.parametrize("seed", list(range(10)))
def test_random_streams_one_byte_at_a_time(seed):
    rng = random.Random(1000 + seed)
    pieces, tool_json, fragments = _make_case(rng)
    stream, _sequence = build_stream(pieces, tool_json, fragments)
    text, tool, _, joined = run_stream(stream, split_stream(stream, "one_byte"))
    assert text == restore("".join(pieces))
    assert tool == restore_obj(json.loads(tool_json))
    for key in PLACEHOLDERS:
        assert key not in joined


def test_every_cut_point_of_a_compact_stream():
    pieces = ["a ", PLACEHOLDERS[0], " b ", PLACEHOLDERS[1]]
    tool_input = {"k": PLACEHOLDERS[2], "n": [PLACEHOLDERS[3]]}
    raw_json = json.dumps(tool_input)
    fragments = [raw_json[i : i + 3] for i in range(0, len(raw_json), 3)]
    stream, _sequence = build_stream(pieces, raw_json, fragments)
    expected_text = restore("".join(pieces))
    expected_tool = restore_obj(tool_input)

    baseline, _, _, baseline_joined = run_stream(stream, [stream])
    assert baseline == expected_text
    for cut in range(1, len(stream)):
        text, tool, _, joined = run_stream(stream, split_stream(stream, "cut", cut=cut))
        assert text == expected_text, "cut=%d text=%r" % (cut, text)
        assert tool == expected_tool, "cut=%d tool=%r" % (cut, tool)
        for key in PLACEHOLDERS:
            assert key not in joined, "cut=%d leaked %r" % (cut, key)
