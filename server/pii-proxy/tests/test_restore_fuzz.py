"""Restore fuzz: the shapes that the first round of tests missed.

The bug this file guards against: a placeholder that sits *early* in a text delta
and is longer than the bytes that follow it inside the hold-back window used to be
emitted half-restored (the old code only recognised PII_-token shapes).

Every placeholder shape (fake email / fake IP / legacy token) is now tested with:
  * prefix padding 0..300 chars and suffix padding 0..300 chars;
  * five chunking strategies, including every cut point inside the placeholder.
"""

from __future__ import annotations

import json
import random

import pytest

from pii_stream import SSERestorer, TextHold

PAIRS = {
    "harper.novak@example.net": "qi.wei@corp-internal.test",
    "10.159.198.181": "117.72.145.38",
    "PII_EMAIL_ADDRESS_abcdef": "edward@jqmt.catwang.top",
    "password=FR(L-+m-vGJB": "password=DevTestPW42",
}
PLACEHOLDERS = list(PAIRS)
MAX_LEN = max(len(k) for k in PAIRS)


def restore(text: str) -> str:
    for key in sorted(PAIRS, key=len, reverse=True):
        text = text.replace(key, PAIRS[key])
    return text


def _chunks(text: str, strategy: str, seed: int = 7) -> list[str]:
    if strategy == "whole":
        return [text]
    if strategy == "one_char":
        return list(text)
    if strategy == "random":
        rng = random.Random(seed)
        out, i = [], 0
        while i < len(text):
            n = rng.randint(1, 17)
            out.append(text[i : i + n])
            i += n
        return out
    if strategy == "inside":
        # split at every offset that falls inside a placeholder, sequentially
        cuts = set()
        for key in PAIRS:
            start = text.find(key)
            if start >= 0:
                cuts.update(start + 1 + i for i in range(len(key) - 1))
        out, last = [], 0
        for cut in sorted(cuts):
            out.append(text[last:cut])
            last = cut
        out.append(text[last:])
        return [c for c in out if c] or [text]
    raise AssertionError(strategy)


@pytest.mark.parametrize("placeholder", PLACEHOLDERS)
@pytest.mark.parametrize("pad_before", [0, 1, 7, 50, 300])
@pytest.mark.parametrize("pad_after", [0, 1, 7, 50, 300])
def test_text_hold_restores_any_position(placeholder, pad_before, pad_after):
    text = "A" * pad_before + placeholder + "B" * pad_after
    expected = restore(text)
    hold = TextHold(MAX_LEN, restore, PLACEHOLDERS)
    out = "".join(hold.feed(chunk) for chunk in _chunks(text, "one_char"))
    out += hold.flush()
    assert out == expected
    assert placeholder not in out


@pytest.mark.parametrize("placeholder", PLACEHOLDERS)
@pytest.mark.parametrize("strategy", ["whole", "random", "inside"])
def test_text_hold_every_chunking(placeholder, strategy):
    text = "prefix " + placeholder + " suffix " + "z" * 40
    expected = restore(text)
    hold = TextHold(MAX_LEN, restore, PLACEHOLDERS)
    out = "".join(hold.feed(chunk) for chunk in _chunks(text, strategy))
    out += hold.flush()
    assert out == expected
    assert placeholder not in out


def _sse(text: str) -> bytes:
    event = {
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "text_delta", "text": text},
    }
    return b"data: " + json.dumps(event).encode() + b"\n\n"


def _parse_text(frames: list[bytes]) -> str:
    parts = []
    for frame in frames:
        line = frame.decode().strip()
        if not line.startswith("data: "):
            continue
        payload = line[len("data: "):]
        if payload == "[DONE]":
            continue
        obj = json.loads(payload)
        delta = obj.get("delta") or {}
        if delta.get("text"):
            parts.append(delta["text"])
    return "".join(parts)


@pytest.mark.parametrize("strategy", ["whole", "one_char", "random", "inside"])
@pytest.mark.parametrize("padding", [0, 3, 40, 200])
def test_sse_restores_placeholder_in_any_position(strategy, padding):
    text = "lead " + PAIRS.__iter__().__next__() + " mid " + "10.159.198.181" + " tail " * (padding // 5)
    stream = _sse(text)
    restorer = SSERestorer(restore, MAX_LEN, PLACEHOLDERS)

    if strategy == "inside":
        cuts = set()
        for key in PLACEHOLDERS:
            idx = stream.find(key.encode())
            if idx >= 0:
                cuts.update(idx + 1 + i for i in range(len(key) - 1))
        chunks, last = [], 0
        for cut in sorted(cuts):
            chunks.append(stream[last:cut])
            last = cut
        chunks.append(stream[last:])
        chunks = [c for c in chunks if c]
    elif strategy == "one_char":
        chunks = [stream[i : i + 1] for i in range(len(stream))]
    elif strategy == "random":
        rng = random.Random(padding)
        chunks, i = [], 0
        while i < len(stream):
            n = rng.randint(1, 11)
            chunks.append(stream[i : i + n])
            i += n
    else:
        chunks = [stream]

    frames: list[bytes] = []
    for chunk in chunks:
        frames.extend(restorer.feed(chunk))
    frames.extend(restorer.flush())

    for frame in frames:
        line = frame.decode().strip()
        if line.startswith("data: ") and line[6:] != "[DONE]":
            json.loads(line[6:])  # every frame must stay valid JSON

    assert _parse_text(frames) == restore(text)
    for key in PAIRS:
        assert key not in _parse_text(frames)


def test_random_texts_and_chunkings_are_lossless():
    rng = random.Random(1234)
    for _ in range(200):
        pieces = [rng.choice(["alpha ", "beta ", "", "x" * rng.randint(0, 30)])]
        for key in rng.sample(PLACEHOLDERS, rng.randint(1, len(PLACEHOLDERS))):
            pieces.append(key)
            pieces.append(rng.choice([" ", ".", "\n", "y" * rng.randint(0, 20)]))
        text = "".join(pieces)
        expected = restore(text)
        hold = TextHold(MAX_LEN, restore, PLACEHOLDERS)
        out = ""
        while text:
            n = rng.randint(1, 12)
            out += hold.feed(text[:n])
            text = text[n:]
        out += hold.flush()
        assert out == expected
