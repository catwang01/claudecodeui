
"""Tests for pii_stream.SSERestorer / TextHold (issue #24, stream layer).

The acceptance criteria covered here:

1. Any-split invariant: for every single split point and random multi-splits
   of a synthetic stream, feeding in pieces produces byte-identical output
   to a single feed.
2. D1 regression: a restored value containing quotes / backslashes /
   newlines is re-encoded so every emitted data: frame stays valid JSON.
3. D2 regression: a placeholder split across two frames (including inside
   the PII prefix, e.g. "PII" + "_EMAIL_xxx") is still restored, at the
   event level and at the transport-chunk level.
4. input_json_delta: the reconstructed frame count matches the original and
   the concatenated partial_json parses to the restored value.
5. thinking/signature passthrough with correct counters; a broken JSON frame
   is passed through verbatim and parse_errors is counted.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pii_stream import SSERestorer, TextHold  # noqa: E402

ALIAS = "PII_EMAIL_2b7c1d"
VALUE = "alice@example.com"
MAX_LEN = len(ALIAS)


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


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def frame(event, data):
    return ("event: " + event + "\ndata: " + json.dumps(data) + "\n\n").encode("utf-8")


def delta_frame(index, delta):
    return frame(
        "content_block_delta",
        {"type": "content_block_delta", "index": index, "delta": delta},
    )


def iter_data(out_frames):
    for raw in out_frames:
        for line in raw.decode("utf-8").split("\n"):
            if not line.startswith("data:"):
                continue
            payload = line[5:]
            if payload.startswith(" "):
                payload = payload[1:]
            if not payload.strip() or payload.strip() == "[DONE]":
                continue
            yield json.loads(payload)


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
    return "".join(d.get("text", "") for d in collect_delta(out_frames, "text_delta"))


def collect_input_json(out_frames, index=None):
    return "".join(
        d.get("partial_json", "") for d in collect_delta(out_frames, "input_json_delta", index)
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


def build_stream():
    """A synthetic Anthropic-ish stream exercising every branch."""
    frames = []
    frames.append(
        frame(
            "message_start",
            {
                "type": "message_start",
                "message": {"id": "msg_1", "content": [], "usage": {"input_tokens": 3}},
            },
        )
    )
    frames.append(
        frame(
            "content_block_start",
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        )
    )
    text_parts = [
        "Hello ",
        "user ",
        ALIAS[:4],  # "PII_"  -> split inside placeholder
        ALIAS[4:],
        ' bye "quote" \\slash\nnewline',
    ]
    for part in text_parts:
        frames.append(delta_frame(0, {"type": "text_delta", "text": part}))
    frames.append(
        frame("content_block_stop", {"type": "content_block_stop", "index": 0})
    )

    frames.append(
        frame(
            "content_block_start",
            {"type": "content_block_start", "index": 1, "content_block": {"type": "thinking", "thinking": ""}},
        )
    )
    frames.append(
        delta_frame(1, {"type": "thinking_delta", "thinking": "reasoning " + ALIAS})
    )
    frames.append(delta_frame(1, {"type": "signature_delta", "signature": "c2lnbmF0dXJl=="}))
    frames.append(
        frame("content_block_stop", {"type": "content_block_stop", "index": 1})
    )

    tool = {"email": ALIAS, "note": 'a"b\\c\nd', "nested": {"list": [ALIAS, 7]}}
    serialized = json.dumps(tool)
    frames.append(
        frame(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 2,
                "content_block": {"type": "tool_use", "id": "toolu_1", "name": "do_it", "input": {}},
            },
        )
    )
    for piece in split_evenly(serialized, 7):
        frames.append(delta_frame(2, {"type": "input_json_delta", "partial_json": piece}))
    frames.append(
        frame("content_block_stop", {"type": "content_block_stop", "index": 2})
    )
    frames.append(
        frame(
            "message_delta",
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 9}},
        )
    )
    frames.append(frame("message_stop", {"type": "message_stop"}))
    return b"".join(frames)


# ---------------------------------------------------------------------------
# TextHold
# ---------------------------------------------------------------------------


def test_text_hold_conserves_all_text():
    hold = TextHold(MAX_LEN, DictRestore({ALIAS: VALUE}))
    out = hold.feed("hello ") + hold.feed("world ") + hold.flush()
    assert out == "hello world "


def test_text_hold_max_len_zero_emits_immediately():
    hold = TextHold(0, DictRestore({ALIAS: VALUE}))
    assert hold.feed("pre " + ALIAS + " post") == "pre " + VALUE + " post"
    assert hold.flush() == ""


@pytest.mark.parametrize("cut", list(range(1, len(ALIAS))))
def test_text_hold_split_never_leaks(cut):
    restore = DictRestore({ALIAS: VALUE})
    hold = TextHold(MAX_LEN, restore)
    got = hold.feed("a " + ALIAS[:cut]) + hold.feed(ALIAS[cut:] + " b") + hold.flush()
    assert got == "a " + VALUE + " b"
    assert ALIAS not in got


def test_text_hold_straddling_alias_moves_cut_back():
    # Cut falls *inside* the alias while trailing text exists; a naive fixed
    # hold-back would emit "xxx...PII_EMA" and lose the alias.
    restore = DictRestore({ALIAS: VALUE})
    hold = TextHold(MAX_LEN, restore)
    emitted = hold.feed("x" * 10 + ALIAS + "yy")
    assert emitted == "x" * 10  # alias + "yy" held back
    emitted += hold.feed("z" * 40) + hold.flush()
    assert emitted == "x" * 10 + VALUE + "yy" + "z" * 40


def test_text_hold_bounded_by_two_max_len():
    hold = TextHold(MAX_LEN, DictRestore({ALIAS: VALUE}))
    hold.feed("q" * 500 + "PII")
    assert len(hold.pending) <= 2 * MAX_LEN


# ---------------------------------------------------------------------------
# acceptance 1: any-split invariant
# ---------------------------------------------------------------------------


def test_any_split_invariant_single_cut_points():
    stream = build_stream()
    single = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    reference = b"".join(single.feed(stream)) + b"".join(single.flush())

    for cut in range(1, len(stream)):
        r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
        out = b"".join(r.feed(stream[:cut]))
        out += b"".join(r.feed(stream[cut:]))
        out += b"".join(r.flush())
        assert out == reference, "mismatch at split point %d" % cut


def test_any_split_invariant_random_multi_splits():
    stream = build_stream()
    single = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    reference = b"".join(single.feed(stream)) + b"".join(single.flush())

    rng = random.Random(20241031)
    for _ in range(300):
        ncuts = rng.randint(1, 6)
        cuts = sorted(rng.sample(range(1, len(stream)), min(ncuts, len(stream) - 1)))
        r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
        out = bytearray()
        prev = 0
        for cut in cuts:
            out += b"".join(r.feed(stream[prev:cut]))
            prev = cut
        out += b"".join(r.feed(stream[prev:]))
        out += b"".join(r.flush())
        assert bytes(out) == reference, "mismatch at splits %r" % (cuts,)


def test_invariant_holds_for_byte_at_a_time_feed():
    stream = build_stream()
    single = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    reference = b"".join(single.feed(stream)) + b"".join(single.flush())

    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = bytearray()
    for i in range(len(stream)):
        out += b"".join(r.feed(stream[i : i + 1]))
    out += b"".join(r.flush())
    assert bytes(out) == reference


def test_output_frames_are_valid_sse_json():
    stream = build_stream()
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = b"".join(r.feed(stream)) + b"".join(r.flush())
    assert out.endswith(b"\n\n")
    for chunk in out.split(b"\n\n"):
        if not chunk.strip():
            continue
        for line in chunk.decode("utf-8").split("\n"):
            if line.startswith("data:"):
                json.loads(line[5:].strip())
    # text reconstructed with the alias restored
    text = collect_text(out.split(b"\n\n"))
    assert VALUE in text and ALIAS not in text


# ---------------------------------------------------------------------------
# acceptance 2: D1 - json escaping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        'say "hi"',
        "back\\slash\\",
        "line1\nline2",
        'all "three" \\ and\nnewline',
        "\u4e2d\u6587\u2014value",
    ],
)
def test_d1_restored_special_chars_stay_valid_json(value):
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "prefix " + ALIAS + " suffix"}),
            frame("content_block_stop", {"type": "content_block_stop", "index": 0}),
            frame("message_stop", {"type": "message_stop"}),
        ]
    )
    r = SSERestorer(DictRestore({ALIAS: value}), MAX_LEN)
    out = b"".join(r.feed(stream)) + b"".join(r.flush())

    frames = out.split(b"\n\n")
    parsed = 0
    for raw in frames:
        if not raw.strip():
            continue
        for line in raw.decode("utf-8").split("\n"):
            if line.startswith("data:"):
                json.loads(line[5:].strip())
                parsed += 1
    assert parsed >= 2
    assert collect_text(frames) == "prefix " + value + " suffix"


# ---------------------------------------------------------------------------
# acceptance 3: D2 - split placeholders
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("cut", list(range(0, len(ALIAS) + 1)))
def test_d2_placeholder_split_across_deltas(cut):
    first = "PII_EMAIL_"[: max(cut, 0)]
    second = ALIAS[len(first) :]
    # keep it well-defined: feed exactly the alias split at "cut"
    first, second = ALIAS[:cut], ALIAS[cut:]
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "before " + first}),
            delta_frame(0, {"type": "text_delta", "text": second + " after"}),
            frame("content_block_stop", {"type": "content_block_stop", "index": 0}),
            frame("message_stop", {"type": "message_stop"}),
        ]
    )
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = b"".join(r.feed(stream)) + b"".join(r.flush())
    assert collect_text(out.split(b"\n\n")) == "before " + VALUE + " after"


def test_d2_transport_chunk_split_inside_placeholder():
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "id=" + ALIAS + "!"}),
            frame("content_block_stop", {"type": "content_block_stop", "index": 0}),
            frame("message_stop", {"type": "message_stop"}),
        ]
    )
    for chunk_size in (1, 2, 3, 5, 7, 11, 13):
        r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
        out = bytearray()
        for i in range(0, len(stream), chunk_size):
            out += b"".join(r.feed(stream[i : i + chunk_size]))
        out += b"".join(r.flush())
        assert collect_text(bytes(out).split(b"\n\n")) == "id=" + VALUE + "!"


def test_d2_placeholder_split_just_after_pii_prefix():
    # The reported failure mode: "PII" | "_EMAIL_xxx".
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "PII"}),
            delta_frame(0, {"type": "text_delta", "text": "_EMAIL_2b7c1d"}),
            frame("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ]
    )
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = b"".join(r.feed(stream)) + b"".join(r.flush())
    assert collect_text(out.split(b"\n\n")) == VALUE


def test_d2_split_placeholder_survives_late_message_stop():
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "x " + ALIAS[:6]}),
            delta_frame(0, {"type": "text_delta", "text": ALIAS[6:]}),
            frame("message_stop", {"type": "message_stop"}),
        ]
    )
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = b"".join(r.feed(stream)) + b"".join(r.flush())
    assert collect_text(out.split(b"\n\n")) == "x " + VALUE


# ---------------------------------------------------------------------------
# acceptance 4: input_json_delta
# ---------------------------------------------------------------------------


def test_input_json_delta_frame_count_and_restore():
    tool = {"email": ALIAS, "note": 'a"b\\c\nd', "nested": {"list": [ALIAS, 7]}}
    serialized = json.dumps(tool)
    original_count = 7
    pieces = split_evenly(serialized, original_count)

    frames = [delta_frame(2, {"type": "input_json_delta", "partial_json": p}) for p in pieces]
    frames.append(frame("content_block_stop", {"type": "content_block_stop", "index": 2}))
    frames.append(frame("message_stop", {"type": "message_stop"}))
    stream = b"".join(frames)

    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out_frames = r.feed(stream) + r.flush()

    assert len(collect_delta(out_frames, "input_json_delta", 2)) == original_count
    joined = collect_input_json(out_frames, 2)
    restored = json.loads(joined)
    assert restored["email"] == VALUE
    assert restored["note"] == tool["note"]
    assert restored["nested"]["list"] == [VALUE, 7]
    # stop frame still present and last
    types = [d.get("type") for d in iter_data(out_frames)]
    assert types.count("content_block_stop") == 1
    # the stop frame immediately follows the reconstructed input_json_delta frames
    assert types[-2] == "content_block_stop"
    assert types[-1] == "message_stop"


def test_input_json_delta_split_inside_alias_across_frames():
    tool = {"e": ALIAS}
    serialized = json.dumps(tool)
    # force a split inside the alias
    idx = serialized.index(ALIAS) + 4
    pieces = [serialized[:idx], serialized[idx:]]
    frames = [delta_frame(0, {"type": "input_json_delta", "partial_json": p}) for p in pieces]
    frames.append(frame("content_block_stop", {"type": "content_block_stop", "index": 0}))
    stream = b"".join(frames)

    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert len(collect_delta(out, "input_json_delta", 0)) == 2
    assert json.loads(collect_input_json(out, 0)) == {"e": VALUE}


def test_unparsable_partial_json_split_back_unchanged():
    raw = '{"broken": "PII_EMAIL_2b7c1d'  # truncated / invalid JSON
    pieces = [raw[:10], raw[10:]]
    frames = [delta_frame(0, {"type": "input_json_delta", "partial_json": p}) for p in pieces]
    frames.append(frame("content_block_stop", {"type": "content_block_stop", "index": 0}))
    stream = b"".join(frames)

    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    emitted = collect_delta(out, "input_json_delta", 0)
    assert len(emitted) == 2
    assert collect_input_json(out, 0) == raw
    assert r.stats["unresolved"] >= 1


def test_multiple_tool_blocks_restored_independently():
    frames = []
    for index in (0, 1):
        value = {"e": ALIAS, "i": index}
        for piece in split_evenly(json.dumps(value), 3):
            frames.append(delta_frame(index, {"type": "input_json_delta", "partial_json": piece}))
        frames.append(frame("content_block_stop", {"type": "content_block_stop", "index": index}))
    frames.append(frame("message_stop", {"type": "message_stop"}))
    stream = b"".join(frames)

    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert json.loads(collect_input_json(out, 0)) == {"e": VALUE, "i": 0}
    assert json.loads(collect_input_json(out, 1)) == {"e": VALUE, "i": 1}


# ---------------------------------------------------------------------------
# acceptance 5: thinking/signature passthrough + bad JSON
# ---------------------------------------------------------------------------


def test_thinking_and_signature_passed_through_verbatim():
    thinking = delta_frame(0, {"type": "thinking_delta", "thinking": "secret " + ALIAS})
    signature = delta_frame(0, {"type": "signature_delta", "signature": "c2ln=="})
    stream = thinking + signature
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert out == [thinking, signature]
    assert r.stats["thinking_passthrough"] == 2
    assert r.stats["restored"] == 0
    assert r.stats["parse_errors"] == 0
    # thinking is NOT restored
    assert ALIAS in out[0].decode("utf-8")


def test_bad_json_frame_passthrough_and_count():
    good = delta_frame(0, {"type": "text_delta", "text": "ok"})
    bad = b'event: content_block_delta\ndata: {"type": "content_block_delta", broken\n\n'
    stream = good + bad
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert bad in out
    assert r.stats["parse_errors"] == 1
    assert r.stats["framed"] == 2


def test_frames_without_data_are_passed_through():
    ping = b": keep-alive\n\n"
    bare_event = b"event: message_stop\n\n"
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(ping + bare_event) + r.flush()
    assert out == [ping, bare_event]
    assert r.stats["parse_errors"] == 0
    assert r.stats["framed"] == 2


def test_frame_without_data_but_message_stop_flushes_holds():
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "tail " + ALIAS}),
            b"event: message_stop\n\n",
        ]
    )
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert collect_text(out) == "tail " + VALUE
    assert out[-1] == b"event: message_stop\n\n"


def test_empty_data_and_done_sentinels_passthrough_without_parse_error():
    stream = b"data: \n\ndata: [DONE]\n\n"
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert out == [b"data: \n\n", b"data: [DONE]\n\n"]
    assert r.stats["parse_errors"] == 0


# ---------------------------------------------------------------------------
# misc: stats, ordering, flush semantics
# ---------------------------------------------------------------------------


def test_stats_shape_and_copy():
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    assert set(r.stats) == {
        "framed",
        "parse_errors",
        "restored",
        "unresolved",
        "thinking_passthrough",
    }
    snap = r.stats
    snap["framed"] = 999
    assert r.stats["framed"] == 0


def test_text_flushed_before_its_content_block_stop():
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "tail " + ALIAS}),
            frame("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ]
    )
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert collect_text(out) == "tail " + VALUE
    # text frame emitted *before* the stop frame
    stop_pos = next(i for i, raw in enumerate(out) if b"content_block_stop" in raw)
    text_pos = next(i for i, raw in enumerate(out) if b"text_delta" in raw)
    assert text_pos < stop_pos


def test_flush_is_idempotent():
    stream = delta_frame(0, {"type": "text_delta", "text": "hello"})
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream)
    first = r.flush()
    second = r.flush()
    assert second == []
    assert collect_text(out + first) == "hello"


def test_unknown_delta_type_passthrough():
    weird = delta_frame(0, {"type": "some_future_delta", "blob": "x"})
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    assert r.feed(weird) == [weird]
    assert r.stats["thinking_passthrough"] == 0


def test_unresolved_counter_for_unknown_alias():
    unknown = "PII_SECRET_abcdef"
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "value=" + unknown}),
            frame("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ]
    )
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert unknown in collect_text(out)
    assert r.stats["unresolved"] == 1
    assert r.stats["restored"] == 0


def test_restored_counter_increments_on_change():
    stream = b"".join(
        [
            delta_frame(0, {"type": "text_delta", "text": "a " + ALIAS}),
            frame("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ]
    )
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    r.feed(stream)
    r.flush()
    assert r.stats["restored"] == 1

def test_partials_flushed_at_message_stop_without_stop_frame():
    # A truncated upstream may never send content_block_stop; the accumulated
    # tool arguments must still be emitted (fail-open), before message_stop.
    serialized = json.dumps({"e": ALIAS, "n": 1})
    pieces = split_evenly(serialized, 4)
    frames = [delta_frame(3, {"type": "input_json_delta", "partial_json": p}) for p in pieces]
    frames.append(frame("message_stop", {"type": "message_stop"}))
    stream = b"".join(frames)

    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert len(collect_delta(out, "input_json_delta", 3)) == 4
    assert json.loads(collect_input_json(out, 3)) == {"e": VALUE, "n": 1}
    assert out[-1] == frame("message_stop", {"type": "message_stop"})


def test_partials_flushed_at_eof_without_any_closing_frame():
    serialized = json.dumps({"e": ALIAS})
    pieces = split_evenly(serialized, 3)
    stream = b"".join(
        delta_frame(0, {"type": "input_json_delta", "partial_json": p}) for p in pieces
    )
    r = SSERestorer(DictRestore({ALIAS: VALUE}), MAX_LEN)
    out = r.feed(stream) + r.flush()
    assert len(collect_delta(out, "input_json_delta", 0)) == 3
    assert json.loads(collect_input_json(out, 0)) == {"e": VALUE}

