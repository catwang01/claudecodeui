"""Boundary / malformed-input hardening tests for pii_stream (issue #24).

This file complements tests/test_stream.py.  It deliberately targets the
degenerate inputs the happy-path suite does not: malformed SSE frames,
multi-byte characters split across transport chunks at the byte level, very
large / very fragmented streams, JSON escaping and nesting corners, hold-back
boundaries, counter semantics and replay determinism.

Recorded actual behaviour (production code is intentionally not modified)
------------------------------------------------------------------------
* The only recognised frame separator is the two-byte sequence b"\n\n".
  CRLF (b"\r\n\r\n") is NOT a separator.  A CRLF stream is therefore consumed
  as a single frame at flush() time.  A *single* CRLF frame is still parsed
  (json.loads tolerates the trailing "\r") and its text is restored, but it is
  re-serialised with LF, so the bytes are not identical.  Two or more CRLF
  frames reach flush() as one frame, fail JSON parsing, and are passed through
  verbatim (input + b"\n\n").  Either way no payload bytes are lost.
* A final frame without its blank-line terminator is completed on flush().
* Extra blank lines between events become empty frames: each is emitted as
  b"\n\n" and each increments the framed counter.
* Empty / whitespace / [DONE] / invalid-JSON data payloads are passed through
  byte-identically; only invalid JSON bumps parse_errors.
* A text alias truncated before it completes (e.g. by message_stop) cannot be
  restored; it is emitted verbatim and counts toward unresolved only when the
  surviving text still matches the canonical alias shape.
* input_json_delta restoration walks string *values* only: an alias used as a
  JSON object key is left untouched (documented in pii_stream's docstring).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pii_stream import SSERestorer, TextHold  # noqa: E402


ALIAS = "PII_EMAIL_2b7c1d"
VALUE = "alice@example.com"
MAX_LEN = len(ALIAS)

ALIAS2 = "PII_PHONE_0a1b2c"
VALUE2 = "+1-555-0100"

EMPTY_STATS = {
    "framed": 0,
    "parse_errors": 0,
    "restored": 0,
    "unresolved": 0,
    "thinking_passthrough": 0,
}


class DictRestore:
    """Test double: exact dict replacement, longest alias first."""

    def __init__(self, mapping):
        self.mapping = dict(mapping)
        self.calls = 0

    def __call__(self, text):
        self.calls += 1
        for key in sorted(self.mapping, key=len, reverse=True):
            text = text.replace(key, self.mapping[key])
        return text


def restore_email(text):
    return text.replace(ALIAS, VALUE)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def raw_frame(*lines):
    """Build a frame from logical lines, terminated with a blank line."""
    return ("\n".join(lines) + "\n\n").encode("utf-8")


def frame(event, data, ensure_ascii=True):
    payload = json.dumps(data, ensure_ascii=ensure_ascii)
    return raw_frame("event: " + event, "data: " + payload)


def delta_frame(index, delta, ensure_ascii=True):
    return frame(
        "content_block_delta",
        {"type": "content_block_delta", "index": index, "delta": delta},
        ensure_ascii=ensure_ascii,
    )


def stop_frame(index):
    return frame("content_block_stop", {"type": "content_block_stop", "index": index})


def message_stop():
    return frame("message_stop", {"type": "message_stop"})


def run_stream(stream, restore=restore_email, max_len=MAX_LEN):
    """Feed *stream* in one chunk and return (joined, frames, stats)."""
    r = SSERestorer(restore, max_len)
    out = r.feed(stream) + r.flush()
    return b"".join(out), out, r.stats


def iter_data(out_frames):
    if isinstance(out_frames, (bytes, bytearray)):
        out_frames = [out_frames]
    for raw in out_frames:
        for line in raw.decode("utf-8").split("\n"):
            if not line.startswith("data:"):
                continue
            payload = line[5:]
            if payload.startswith(" "):
                payload = payload[1:]
            if not payload.strip() or payload.strip() == "[DONE]":
                continue
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                # malformed frames are passed through verbatim; skip them
                continue


def collect_delta(out_frames, dtype, index=None):
    pieces = []
    for data in iter_data(out_frames):
        if data.get("type") != "content_block_delta":
            continue
        if index is not None and data.get("index") != index:
            continue
        delta = data.get("delta") or {}
        if delta.get("type") == dtype:
            pieces.append(delta)
    return pieces


def collect_text(out_frames):
    return "".join(
        d.get("text", "") for d in collect_delta(out_frames, "text_delta")
    )


def collect_text_by_index(out_frames):
    acc = {}
    for data in iter_data(out_frames):
        if data.get("type") != "content_block_delta":
            continue
        delta = data.get("delta") or {}
        if delta.get("type") != "text_delta":
            continue
        idx = data.get("index")
        acc[idx] = acc.get(idx, "") + delta.get("text", "")
    return acc


def collect_input_json(out_frames, index=None):
    return "".join(
        d.get("partial_json", "")
        for d in collect_delta(out_frames, "input_json_delta", index)
    )


def split_evenly(text, count):
    if count == 1:
        return [text]
    size, extra = divmod(len(text), count)
    out, pos = [], 0
    for i in range(count):
        end = pos + size + (1 if i < extra else 0)
        out.append(text[pos:end])
        pos = end
    return out


def assert_data_lines_are_json(out_frames):
    """Every data: payload in the output must be valid JSON (or a sentinel)."""
    if isinstance(out_frames, (bytes, bytearray)):
        raw = out_frames
    else:
        raw = b"".join(out_frames)
    checked = 0
    for chunk in raw.split(b"\n\n"):
        if not chunk.strip():
            continue
        for line in chunk.decode("utf-8").split("\n"):
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            json.loads(payload)
            checked += 1
    return checked


# ---------------------------------------------------------------------------
# 1. malformed SSE
# ---------------------------------------------------------------------------


def test_frame_without_any_data_line_is_passed_through():
    stream = b"only-a-plain-line\n\n"
    joined, frames, stats = run_stream(stream)
    assert frames == [stream]
    assert joined == stream
    assert stats["framed"] == 1
    assert stats["parse_errors"] == 0


@pytest.mark.parametrize("payload", [b"data:\n\n", b"data:\t\n\n", b"data:   \n\n"])
def test_data_payload_empty_or_whitespace_is_passed_through(payload):
    joined, frames, stats = run_stream(payload)
    assert frames == [payload]
    assert stats["framed"] == 1
    assert stats["parse_errors"] == 0
    assert stats["restored"] == 0


def test_data_payload_invalid_json_passthrough_and_counted():
    stream = b"event: content_block_delta\ndata: {this is not json\n\n"
    joined, frames, stats = run_stream(stream)
    assert frames == [stream]
    assert joined == stream
    assert stats == {**EMPTY_STATS, "framed": 1, "parse_errors": 1}


def test_frame_with_only_event_id_retry_fields_passthrough():
    stream = b"event: ping\nid: 42\nretry: 1000\n\n"
    joined, frames, stats = run_stream(stream)
    assert frames == [stream]
    assert stats == {**EMPTY_STATS, "framed": 1}


def test_extra_blank_lines_between_events_become_empty_frames():
    inner = delta_frame(0, {"type": "text_delta", "text": "hi"})
    stream = inner + b"\n\n" + inner
    joined, frames, stats = run_stream(stream)
    # the stray blank line is consumed as an empty frame and echoed as b"\n\n"
    assert frames[0] == b"\n\n"
    assert stats["framed"] == 3
    # both deltas share index 0, so the hold merges them ("hihi") at flush
    assert collect_text(frames) == "hihi"
    assert stats["restored"] == 0


def test_missing_trailing_blank_line_is_completed_on_flush():
    data = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hi"}}
    stream = ("event: content_block_delta\ndata: " + json.dumps(data)).encode("utf-8")
    joined, frames, stats = run_stream(stream)
    assert joined == stream + b"\n\n"
    assert collect_text(frames) == "hi"
    assert stats == {**EMPTY_STATS, "framed": 1}


def test_multiline_data_lines_are_joined_before_parsing():
    # Two data: lines form one JSON payload; parsing succeeds so this is NOT a
    # parse error and the frame passes through untouched.
    stream = b'data: {"a":\ndata: 1}\n\n'
    joined, frames, stats = run_stream(stream)
    assert joined == stream
    assert stats == {**EMPTY_STATS, "framed": 1}


def test_crlf_single_frame_is_flushed_as_one_frame_and_restored():
    data = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "a " + ALIAS + " b"}}
    stream = ("event: content_block_delta\r\ndata: " + json.dumps(data) + "\r\n\r\n").encode("utf-8")

    r = SSERestorer(restore_email, MAX_LEN)
    assert r.feed(stream) == []  # \r\n\r\n is not a separator, so nothing is framed yet
    frames = r.flush()
    joined = b"".join(frames)

    assert r.stats["framed"] == 1
    assert r.stats["parse_errors"] == 0
    # no data loss: the payload still parses and the text is restored
    assert collect_text(frames) == "a " + VALUE + " b"
    assert VALUE.encode() in joined
    assert ALIAS.encode() not in joined
    # ... but the bytes are re-serialised with LF, hence not identical
    assert joined != stream


def test_crlf_multiple_frames_are_passed_through_verbatim_without_loss():
    data = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "a " + ALIAS + " b"}}
    one = ("event: content_block_delta\r\ndata: " + json.dumps(data) + "\r\n\r\n").encode("utf-8")
    stream = one + one

    r = SSERestorer(restore_email, MAX_LEN)
    assert r.feed(stream) == []
    frames = r.flush()
    joined = b"".join(frames)

    assert r.stats["framed"] == 1
    assert r.stats["parse_errors"] == 1  # two data: lines -> invalid JSON
    # exact passthrough of the whole payload, plus the flush terminator
    assert joined == stream + b"\n\n"
    # nothing is lost: the text (alias included) is still there
    assert ALIAS.encode() in joined
    assert b"a " in joined


@pytest.mark.xfail(
    strict=False,
    reason="CRLF is not a recognised frame separator; recorded contract gap",
)
def test_crlf_stream_should_split_into_independent_events():
    data = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "a " + ALIAS + " b"}}
    one = ("event: content_block_delta\r\ndata: " + json.dumps(data) + "\r\n\r\n").encode("utf-8")
    stream = one + one

    r = SSERestorer(restore_email, MAX_LEN)
    frames = r.feed(stream) + r.flush()

    assert r.stats["framed"] == 2
    assert r.stats["parse_errors"] == 0
    assert collect_text(frames) == "a " + VALUE + " ba " + VALUE + " b"


# ---------------------------------------------------------------------------
# 2. half UTF-8 characters
# ---------------------------------------------------------------------------


def _utf8_text_stream():
    text = "\u4f60\u597d\U0001f642\u4e16\u754c " + ALIAS + " ok"
    stream = delta_frame(
        0, {"type": "text_delta", "text": text}, ensure_ascii=False
    ) + stop_frame(0)
    return text, stream


def test_half_utf8_character_split_at_every_byte_produces_identical_output():
    text, stream = _utf8_text_stream()
    ref, _, ref_stats = run_stream(stream)
    assert b"\xef\xbf\xbd" not in ref  # no U+FFFD replacement character
    assert collect_text([ref]) == text.replace(ALIAS, VALUE)

    for cut in range(1, len(stream)):
        r = SSERestorer(restore_email, MAX_LEN)
        out = b"".join(r.feed(stream[:cut]))
        out += b"".join(r.feed(stream[cut:]))
        out += b"".join(r.flush())
        assert out == ref, "mismatch splitting inside multi-byte char at byte %d" % cut

    assert ref_stats["restored"] == 1


def test_half_utf8_explicit_split_inside_multibyte_emoji():
    text, stream = _utf8_text_stream()
    ref, _, _ = run_stream(stream)

    emoji = "\U0001f642".encode("utf-8")
    pos = stream.index(emoji)
    for offset in (1, 2, 3):  # every interior boundary of the 4-byte sequence
        cut = pos + offset
        r = SSERestorer(restore_email, MAX_LEN)
        out = b"".join(r.feed(stream[:cut]))
        out += b"".join(r.feed(stream[cut:]))
        out += b"".join(r.flush())
        assert out == ref
        assert b"\xef\xbf\xbd" not in out


def test_half_utf8_byte_at_a_time_feed():
    text, stream = _utf8_text_stream()
    ref, _, _ = run_stream(stream)

    r = SSERestorer(restore_email, MAX_LEN)
    out = bytearray()
    for i in range(len(stream)):
        out += b"".join(r.feed(stream[i : i + 1]))
    out += b"".join(r.flush())
    assert bytes(out) == ref
    assert collect_text([bytes(out)]) == text.replace(ALIAS, VALUE)


# ---------------------------------------------------------------------------
# 3. very large / very fragmented streams
# ---------------------------------------------------------------------------


def test_huge_single_text_delta_restored_exactly():
    big = "x" * 50000 + " " + ALIAS + " " + "y" * 50000
    stream = delta_frame(0, {"type": "text_delta", "text": big}) + stop_frame(0) + message_stop()
    joined, frames, stats = run_stream(stream)

    got = collect_text(frames)
    assert got == big.replace(ALIAS, VALUE)
    assert got.startswith("x" * 10) and got.endswith("y" * 10)
    assert stats == {**EMPTY_STATS, "framed": 3, "restored": 1}


def test_thousands_of_small_deltas_preserve_text_and_order():
    groups = 750
    parts = ["ab", ALIAS[:7], ALIAS[7:], "cd"] * groups
    assert len(parts) == 3000

    stream = b"".join(
        delta_frame(0, {"type": "text_delta", "text": p}) for p in parts
    ) + stop_frame(0)
    joined, frames, stats = run_stream(stream)

    assert collect_text(frames) == "".join(parts).replace(ALIAS, VALUE)
    assert stats["framed"] == len(parts) + 1
    assert stats["restored"] == groups  # one alias per group
    assert stats["unresolved"] == 0
    assert stats["parse_errors"] == 0


def test_alias_spanning_more_than_two_deltas_is_restored():
    pieces = [ALIAS[i : i + 2] for i in range(0, len(ALIAS), 2)]
    assert len(pieces) == 8  # strictly more than two fragments

    text_parts = ["pre"] + pieces + ["post"]
    stream = b"".join(
        delta_frame(0, {"type": "text_delta", "text": p}) for p in text_parts
    ) + stop_frame(0)
    joined, frames, stats = run_stream(stream)

    assert collect_text(frames) == "pre" + VALUE + "post"
    assert stats["restored"] == 1
    assert stats["unresolved"] == 0


# ---------------------------------------------------------------------------
# 4. nested JSON and escaping
# ---------------------------------------------------------------------------


def test_input_json_special_chars_roundtrip_stays_valid_json():
    tool = {
        "quote": 'he said "hi"',
        "slash": "back\\slash\\",
        "nl": "line1\nline2",
        "cn": "\u4e2d\u6587\u503c",
        "emoji": "\U0001f642\U0001f389",
        "alias": ALIAS,
        "list": [ALIAS, 'a"b', {"deep": ALIAS}],
    }
    serialized = json.dumps(tool, ensure_ascii=False)
    pieces = [serialized[i : i + 5] for i in range(0, len(serialized), 5)]

    stream = b"".join(
        delta_frame(2, {"type": "input_json_delta", "partial_json": p}) for p in pieces
    ) + stop_frame(2) + message_stop()
    joined, frames, stats = run_stream(stream)

    checked = assert_data_lines_are_json(frames)
    assert checked >= len(pieces)
    assert len(collect_delta(frames, "input_json_delta", 2)) == len(pieces)

    parsed = json.loads(collect_input_json(frames, 2))
    expected = {
        "quote": 'he said "hi"',
        "slash": "back\\slash\\",
        "nl": "line1\nline2",
        "cn": "\u4e2d\u6587\u503c",
        "emoji": "\U0001f642\U0001f389",
        "alias": VALUE,
        "list": [VALUE, 'a"b', {"deep": VALUE}],
    }
    assert parsed == expected
    assert stats["restored"] == 3  # alias / list[0] / list[2].deep
    assert stats["unresolved"] == 0
    assert stats["parse_errors"] == 0


def test_input_json_multiple_alias_kinds_in_one_block():
    tool = {"e": ALIAS, "p": ALIAS2, "arr": [ALIAS, ALIAS2]}
    serialized = json.dumps(tool)
    pieces = [serialized[:6], serialized[6:14], serialized[14:]]

    stream = b"".join(
        delta_frame(5, {"type": "input_json_delta", "partial_json": p}) for p in pieces
    ) + stop_frame(5)
    joined, frames, stats = run_stream(
        stream, DictRestore({ALIAS: VALUE, ALIAS2: VALUE2})
    )

    assert json.loads(collect_input_json(frames, 5)) == {
        "e": VALUE,
        "p": VALUE2,
        "arr": [VALUE, VALUE2],
    }
    assert stats["restored"] == 4  # one per string value carrying an alias
    assert stats["unresolved"] == 0


def test_input_json_alias_in_array_elements_is_restored():
    tool = {"arr": [ALIAS, "plain", ALIAS]}
    serialized = json.dumps(tool)
    pieces = [serialized[:4], serialized[4:]]
    stream = b"".join(
        delta_frame(0, {"type": "input_json_delta", "partial_json": p}) for p in pieces
    ) + stop_frame(0)
    joined, frames, stats = run_stream(stream)

    parsed = json.loads(collect_input_json(frames, 0))
    assert parsed == {"arr": [VALUE, "plain", VALUE]}
    assert stats["restored"] == 2


def test_input_json_alias_as_object_key_is_left_untouched():
    key_alias = "PII_NAME_deadbeef"
    serialized = json.dumps({key_alias: ALIAS})
    pieces = [serialized[:9], serialized[9:]]
    stream = b"".join(
        delta_frame(0, {"type": "input_json_delta", "partial_json": p}) for p in pieces
    ) + stop_frame(0)
    joined, frames, stats = run_stream(
        stream, DictRestore({ALIAS: VALUE, key_alias: "bob"})
    )

    parsed = json.loads(collect_input_json(frames, 0))
    # documented behaviour: _restore_obj never rewrites dict keys
    assert parsed == {key_alias: VALUE}
    assert "bob" not in json.dumps(parsed)
    assert stats["restored"] == 1
    assert stats["unresolved"] == 0


# ---------------------------------------------------------------------------
# 5. semantic boundaries
# ---------------------------------------------------------------------------


def test_alias_cut_at_exact_max_len_boundary():
    text = "A" + ALIAS + "B" * 8  # len 24, max_len 16 -> naive cut would be 8
    hold = TextHold(MAX_LEN, restore_email)
    emitted = hold.feed(text)
    assert emitted == "A"
    assert hold.pending == ALIAS + "B" * 8
    assert len(hold.pending) == len(text) - 1
    assert hold.flush() == VALUE + "B" * 8

    stream = delta_frame(0, {"type": "text_delta", "text": text}) + stop_frame(0)
    joined, frames, stats = run_stream(stream)
    assert collect_text(frames) == "A" + VALUE + "B" * 8
    assert stats["restored"] == 1


def test_alias_split_into_exact_max_len_chunks():
    text = "A" * MAX_LEN + ALIAS + "B" * MAX_LEN
    chunks = [text[i : i + MAX_LEN] for i in range(0, len(text), MAX_LEN)]
    assert len(text) % MAX_LEN == 0
    assert all(len(c) == MAX_LEN for c in chunks)

    stream = b"".join(
        delta_frame(0, {"type": "text_delta", "text": c}) for c in chunks
    ) + stop_frame(0)
    joined, frames, stats = run_stream(stream)
    assert collect_text(frames) == text.replace(ALIAS, VALUE)
    assert stats["unresolved"] == 0
    assert stats["restored"] >= 1


@pytest.mark.parametrize(
    "left,right",
    [
        ("(", ")"),
        (".", ","),
        ("[", "]"),
        ("!", "?"),
        ('"', "'"),
        ("\uff0c", "\u3002"),
        ("\u2026", "\uff01"),
    ],
)
def test_alias_directly_adjacent_to_punctuation(left, right):
    text = left + ALIAS + right
    stream = delta_frame(0, {"type": "text_delta", "text": text}) + stop_frame(0)
    joined, frames, stats = run_stream(stream)
    assert collect_text(frames) == left + VALUE + right
    assert stats["unresolved"] == 0
    assert stats["restored"] == 1


def test_alias_truncated_by_message_stop_is_emitted_verbatim():
    partial = ALIAS[:8]  # "PII_EMAI" -- no longer canonical
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "keep this "}),
            delta_frame(0, {"type": "text_delta", "text": partial}),
            message_stop(),
        ]
    )
    joined, frames, stats = run_stream(stream)

    assert collect_text(frames) == "keep this " + partial
    assert stats["restored"] == 0
    assert stats["unresolved"] == 0  # truncated prefix is not a canonical alias
    assert stats["parse_errors"] == 0
    assert frames[-1] == message_stop()
    assert VALUE.encode() not in joined


def test_unknown_canonical_alias_flushed_by_message_stop_counts_unresolved():
    unknown = "PII_SECRET_abcdef"
    stream = delta_frame(0, {"type": "text_delta", "text": "v=" + unknown}) + message_stop()
    joined, frames, stats = run_stream(stream)

    assert collect_text(frames) == "v=" + unknown
    assert stats["restored"] == 0
    assert stats["unresolved"] == 1


# ---------------------------------------------------------------------------
# 6. state and counters
# ---------------------------------------------------------------------------


def test_all_counters_on_a_single_mixed_stream():
    stream = b"".join(
        [
            frame("message_start", {"type": "message_start", "message": {}}),
            delta_frame(0, {"type": "text_delta", "text": "a " + ALIAS}),
            delta_frame(0, {"type": "thinking_delta", "thinking": "t"}),
            delta_frame(0, {"type": "signature_delta", "signature": "sig"}),
            raw_frame("event: content_block_delta", "data: {bad json"),
            b"data:\n\n",
            b"event: ping\n\n",
            stop_frame(0),
            message_stop(),
        ]
    )
    joined, frames, stats = run_stream(stream)

    assert stats == {
        "framed": 9,
        "parse_errors": 1,
        "restored": 1,
        "unresolved": 0,
        "thinking_passthrough": 2,
    }
    assert collect_text(frames) == "a " + VALUE
    assert frames[-1] == message_stop()


def test_consecutive_text_blocks_with_increasing_indices():
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "zero " + ALIAS}),
            stop_frame(0),
            delta_frame(1, {"type": "text_delta", "text": "one " + ALIAS}),
            stop_frame(1),
            message_stop(),
        ]
    )
    joined, frames, stats = run_stream(stream)
    assert collect_text_by_index(frames) == {0: "zero " + VALUE, 1: "one " + VALUE}
    assert stats["restored"] == 2
    assert stats["unresolved"] == 0


def test_out_of_order_text_blocks_have_independent_buffers():
    stream = b"".join(
        [
            delta_frame(1, {"type": "text_delta", "text": "one " + ALIAS}),
            delta_frame(0, {"type": "text_delta", "text": "zero " + ALIAS}),
            stop_frame(1),
            stop_frame(0),
        ]
    )
    joined, frames, stats = run_stream(stream)
    assert collect_text_by_index(frames) == {1: "one " + VALUE, 0: "zero " + VALUE}
    assert stats["restored"] == 2
    assert stats["unresolved"] == 0


def test_out_of_order_tool_blocks_have_independent_buffers():
    ser2 = json.dumps({"v": ALIAS})
    ser0 = json.dumps({"i": 0, "v": ALIAS})
    p2 = split_evenly(ser2, 3)
    p0 = split_evenly(ser0, 3)

    frames_bytes = []
    for a, b in zip(p2, p0):
        frames_bytes.append(delta_frame(2, {"type": "input_json_delta", "partial_json": a}))
        frames_bytes.append(delta_frame(0, {"type": "input_json_delta", "partial_json": b}))
    frames_bytes.append(stop_frame(2))
    frames_bytes.append(stop_frame(0))
    frames_bytes.append(message_stop())

    joined, frames, stats = run_stream(b"".join(frames_bytes))
    assert json.loads(collect_input_json(frames, 2)) == {"v": VALUE}
    assert json.loads(collect_input_json(frames, 0)) == {"i": 0, "v": VALUE}
    assert stats["restored"] == 2


def test_repeated_content_block_stop_emits_no_duplicate_partials():
    ser = json.dumps({"e": ALIAS})
    stream = b"".join(
        [
            delta_frame(0, {"type": "input_json_delta", "partial_json": ser[:5]}),
            delta_frame(0, {"type": "input_json_delta", "partial_json": ser[5:]}),
            stop_frame(0),
            stop_frame(0),
        ]
    )
    joined, frames, stats = run_stream(stream)

    assert len(collect_delta(frames, "input_json_delta", 0)) == 2
    assert json.loads(collect_input_json(frames, 0)) == {"e": VALUE}
    assert len([raw for raw in frames if b"content_block_stop" in raw]) == 2
    assert stats == {**EMPTY_STATS, "framed": 4, "restored": 1}


# ---------------------------------------------------------------------------
# 7. replay / determinism
# ---------------------------------------------------------------------------


def build_rich_stream():
    tool = {"e": ALIAS, "n": [ALIAS, {"k": ALIAS2}]}
    serialized = json.dumps(tool)
    return b"".join(
        [
            frame("message_start", {"type": "message_start", "message": {}}),
            delta_frame(0, {"type": "text_delta", "text": "hello " + ALIAS + " "}),
            delta_frame(0, {"type": "thinking_delta", "thinking": "reason"}),
            delta_frame(0, {"type": "text_delta", "text": "tail"}),
            stop_frame(0),
            b"data:\n\n",
            raw_frame("event: content_block_delta", "data: {broken"),
            b"".join(
                delta_frame(3, {"type": "input_json_delta", "partial_json": p})
                for p in split_evenly(serialized, 4)
            ),
            stop_frame(3),
            message_stop(),
        ]
    )


def test_replay_into_new_restorer_is_byte_identical():
    stream = build_rich_stream()
    restore = DictRestore({ALIAS: VALUE, ALIAS2: VALUE2})

    joined1, frames1, stats1 = run_stream(stream, restore)
    joined2, frames2, stats2 = run_stream(stream, DictRestore({ALIAS: VALUE, ALIAS2: VALUE2}))

    assert joined1 == joined2
    assert b"".join(frames1) == b"".join(frames2)
    assert stats1 == stats2
    assert stats1["framed"] > 0
    assert collect_text(frames1) == "hello " + VALUE + " tail"
    assert json.loads(collect_input_json(frames1, 3)) == {"e": VALUE, "n": [VALUE, {"k": VALUE2}]}
