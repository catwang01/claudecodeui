
"""Event-level SSE restoration for the PII proxy (v2).

This module replaces the old "treat the SSE stream as opaque text and run a
raw string replacement" approach.  It works on *parsed events* instead::

    bytes -> incremental UTF-8 decode -> split on "\n\n" -> json.loads(data)
          -> rewrite only the fields that may carry an alias -> json.dumps

Two pieces make up the public surface:

TextHold
    Fixed-length hold-back for a text channel.  A placeholder can be split
    across two text_delta events (or two transport chunks), so the last
    max_len characters are never emitted until they are known not to be a
    prefix of a longer placeholder.  The injected restore callback is the
    only thing that knows the alias table, so this class never imports the
    vault or the detector.

SSERestorer
    Stateful frame restorer.  Feed it arbitrary byte chunks; it returns zero
    or more complete SSE frames, each terminated by "\n\n".  For any
    chunking of the same input the concatenation of all returned frames is
    byte-identical (the "any split" invariant).

Statistics
----------
stats reports:

framed
    Complete (or, at stream end, unterminated) SSE frames consumed.
parse_errors
    Frames whose data: payload was not valid JSON.  They are passed
    through untouched (fail-open).
restored
    Number of restore applications that actually changed their input.
    Counting is per restore call, not per alias: a prefix containing three
    aliases resolves in one call and is counted once.
unresolved
    Number of canonical PII_<KIND>_<hex> lookalikes still present in
    restored output (i.e. aliases the injected restore did not resolve).
    Only canonical aliases are counted; deliberately passthrough channels
    (thinking/signature) are not inspected.
thinking_passthrough
    Number of thinking_delta / signature_delta frames passed through
    verbatim.

Behaviour notes
---------------
* data: JSON that fails to parse, frames without a data: line, empty
  payloads and the [DONE] sentinel are passed through byte-identically.
* content_block_delta / text_delta goes through TextHold and the whole
  frame is re-serialised with json.dumps, so quote / backslash / newline
  characters are always re-escaped into valid JSON.
* content_block_delta / input_json_delta is accumulated per index and is
  *not* emitted.  On content_block_stop the accumulated partial_json is
  parsed, its string values are restored recursively, re-serialised and
  split back into exactly as many input_json_delta frames as were consumed,
  immediately followed by the original stop frame.  If the accumulated JSON
  does not parse, the raw partial_json is split back into the same number
  of frames (fail-open).
* thinking_delta / signature_delta are passed through untouched.
* On message_stop and on SSERestorer.flush any remaining TextHold buffers
  and half-open input_json_delta accumulations are flushed first, then the
  closing frame is passed through.  A text block is also flushed when its
  own content_block_stop arrives, so the tail of a text block is never
  emitted after a later content block.
"""

from __future__ import annotations

import codecs
import copy
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

__all__ = ["TextHold", "SSERestorer"]

# Alias alphabet is [A-Za-z0-9_] and every alias starts with PII.
# Matching is case-insensitive so a lower-cased alias still gets held back
# (the injected restore may canonicalise it).
_CANDIDATE_RX = re.compile(r"PII[A-Za-z0-9_]*", re.IGNORECASE)


# Canonical alias shape, used only for the unresolved metric.
_ALIAS_RX = re.compile(r"PII_[A-Z0-9]{1,12}_[0-9a-f]{6,16}")

_FRAME_SEP = "\n\n"
_DONE = "[DONE]"


class TextHold:
    """Fixed-length hold-back + restore for one streaming text channel."""

    def __init__(
        self,
        max_len: int,
        restore: Callable[[str], str],
        placeholders: "Iterable[str] | None" = None,
        candidate_rx: "re.Pattern[str] | None" = None,
    ) -> None:
        if not callable(restore):
            raise TypeError("restore must be callable")
        self.max_len = max(0, int(max_len))
        self._restore = restore
        self._buf = ""
        # Forward and reverse use the *same* matcher: the alternation of the
        # known placeholders. Forward it decides what to replace on a complete
        # string; on a stream it additionally tells us whether a match would
        # straddle the emit boundary, in which case we hold back from that
        # match's start. No PII_ prefix conventions, no per-shape heuristics.
        self._match_rx = candidate_rx
        if placeholders:
            ordered = sorted({p for p in placeholders if p}, key=len, reverse=True)
            if ordered:
                self._match_rx = re.compile("|".join(re.escape(p) for p in ordered))

    @property
    def pending(self) -> str:
        """Characters currently held back (exposed for tests/observability)."""
        return self._buf

    def feed(self, text: str) -> str:
        """Append *text* and return the restored prefix that is safe to emit."""
        if text:
            self._buf += text
        cut = self._safe_cut()
        if cut <= 0:
            return ""
        prefix = self._buf[:cut]
        self._buf = self._buf[cut:]
        return self._restore(prefix)

    def flush(self) -> str:
        """Emit (and restore) whatever is still held back."""
        if not self._buf:
            return ""
        tail, self._buf = self._buf, ""
        return self._restore(tail)

    # ------------------------------------------------------------------ internal

    def _safe_cut(self) -> int:
        """Largest prefix length that cannot split a placeholder.

        The prefix that ends max_len characters before the end of the buffer
        is safe for *complete* aliases, but a complete alias that straddles
        that cut would be emitted half-restored.  Any candidate token
        starting before the cut and ending after it forces the cut back to
        the candidate start.
        """
        n = len(self._buf)
        if self.max_len <= 0:
            return n
        cut = n - self.max_len
        if cut <= 0:
            return 0
        # An alias has length <= max_len, so a candidate starting before
        # cut - max_len necessarily ends before the cut and does not need to
        # be considered.
        match_rx = self._match_rx
        if match_rx is None:
            # Legacy fallback: only recognise PII_-token shapes.
            match_rx = _CANDIDATE_RX
            for match in match_rx.finditer(self._buf, max(0, cut - self.max_len)):
                start, end = match.span()
                if start < cut < end:
                    return start
            return cut
        for match in match_rx.finditer(self._buf):
            start, end = match.span()
            if start >= cut:
                break
            if end > cut:
                return start  # a complete placeholder would be split: hold it
        return cut


# ---------------------------------------------------------------------------
# SSE frame parsing
# ---------------------------------------------------------------------------


@dataclass
class _ParsedFrame:
    obj: Any = None
    event: str | None = None
    pre: list[str] = field(default_factory=list)
    post: list[str] = field(default_factory=list)
    has_data: bool = False
    parse_error: bool = False


def _parse_frame(frame: str) -> _ParsedFrame:
    lines = frame.split("\n")
    event: str | None = None
    data_idxs: list[int] = []
    payloads: list[str] = []
    for i, line in enumerate(lines):
        if event is None and line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_idxs.append(i)
            payload = line[5:]
            if payload.startswith(" "):
                payload = payload[1:]
            payloads.append(payload)
    parsed = _ParsedFrame(event=event)
    if not data_idxs:
        return parsed
    parsed.has_data = True
    joined = "\n".join(payloads)
    if not joined.strip() or joined.strip() == _DONE:
        # Not a JSON payload at all (heartbeat / protocol sentinel).
        return parsed
    try:
        parsed.obj = json.loads(joined)
    except Exception:
        parsed.parse_error = True
        return parsed
    parsed.pre = lines[: data_idxs[0]]
    parsed.post = lines[data_idxs[-1] + 1 :]
    return parsed


def _render_frame(pre: list[str], post: list[str], obj: Any) -> bytes:
    body = "\n".join([*pre, "data: " + json.dumps(obj), *post])
    return (body + _FRAME_SEP).encode("utf-8")


def _index_of(obj: dict[str, Any]) -> Any:
    idx = obj.get("index")
    try:
        hash(idx)
    except TypeError:
        return json.dumps(idx, sort_keys=True, default=str)
    return idx


def _distribute(text: str, count: int) -> list[str]:
    """Split *text* into exactly *count* pieces (concatenation preserves it)."""
    if count <= 0:
        return []
    if count == 1:
        return [text]
    size, extra = divmod(len(text), count)
    pieces: list[str] = []
    pos = 0
    for i in range(count):
        end = pos + size + (1 if i < extra else 0)
        pieces.append(text[pos:end])
        pos = end
    return pieces


@dataclass
class _TextChannel:
    hold: TextHold
    template: dict[str, Any]
    pre: list[str]
    post: list[str]


@dataclass
class _PartialBlock:
    obj: dict[str, Any]
    pre: list[str]
    post: list[str]
    pieces: list[str] = field(default_factory=list)
    count: int = 0


class SSERestorer:
    """Turn a chunked SSE byte stream into a restored SSE byte stream."""

    def __init__(
        self,
        restore: Callable[[str], str],
        max_len: int,
        placeholders: "Iterable[str] | None" = None,
        candidate_rx: "re.Pattern[str] | None" = None,
    ) -> None:
        if not callable(restore):
            raise TypeError("restore must be callable")
        self._restore_fn = restore
        self.max_len = max(0, int(max_len))
        self._placeholders = tuple(placeholders or ())
        self._candidate_rx = candidate_rx
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._buf = ""
        self._text: dict[Any, _TextChannel] = {}
        self._partials: dict[Any, _PartialBlock] = {}
        self._stats: dict[str, int] = {
            "framed": 0,
            "parse_errors": 0,
            "restored": 0,
            "unresolved": 0,
            "thinking_passthrough": 0,
        }

    # ------------------------------------------------------------------- public

    @property
    def stats(self) -> dict[str, int]:
        return dict(self._stats)

    def feed(self, chunk: bytes) -> list[bytes]:
        """Consume *chunk*; return complete restored SSE frames (0..n)."""
        text = self._decoder.decode(chunk, final=False)
        if text:
            self._buf += text
        out: list[bytes] = []
        while True:
            idx = self._buf.find(_FRAME_SEP)
            if idx < 0:
                break
            frame = self._buf[:idx]
            self._buf = self._buf[idx + 2 :]
            out.extend(self._process_frame(frame))
        return out

    def flush(self) -> list[bytes]:
        """Finish the stream: flush pending holds, the half frame and EOF."""
        out: list[bytes] = []
        tail = self._decoder.decode(b"", final=True)
        if tail:
            self._buf += tail
        if self._buf:
            frame = self._buf
            self._buf = ""
            out.extend(self._process_frame(frame))
        out.extend(self._flush_text())
        out.extend(self._flush_partials())
        return out

    # ------------------------------------------------------------- frame routing

    def _process_frame(self, frame: str) -> list[bytes]:
        self._stats["framed"] += 1
        raw = (frame + _FRAME_SEP).encode("utf-8")
        parsed = _parse_frame(frame)

        if not parsed.has_data:
            if parsed.event == "message_stop":
                return [*self._flush_text(), *self._flush_partials(), raw]
            return [raw]
        if parsed.parse_error:
            self._stats["parse_errors"] += 1
            return [raw]
        obj = parsed.obj
        if not isinstance(obj, dict):
            return [raw]

        dtype = obj.get("type") or parsed.event
        if dtype == "content_block_delta":
            return self._handle_delta(parsed, raw)
        if dtype == "content_block_stop":
            return self._handle_stop(parsed, raw)
        if dtype == "message_stop":
            return [*self._flush_text(), *self._flush_partials(), raw]
        return [raw]

    def _handle_delta(self, parsed: _ParsedFrame, raw: bytes) -> list[bytes]:
        obj = parsed.obj
        delta = obj.get("delta")
        if not isinstance(delta, dict):
            return [raw]
        dtype = delta.get("type")
        idx = _index_of(obj)

        if dtype == "text_delta":
            text = delta.get("text")
            if not isinstance(text, str):
                return [raw]
            channel = self._text.get(idx)
            if channel is None:
                channel = _TextChannel(
                    hold=TextHold(self.max_len, self._restore_counted, self._placeholders, self._candidate_rx),
                    template=copy.deepcopy(obj),
                    pre=parsed.pre,
                    post=parsed.post,
                )
                self._text[idx] = channel
            out = channel.hold.feed(text)
            if not out:
                return []
            new = copy.deepcopy(obj)
            new_delta = new.get("delta")
            new_delta = dict(new_delta) if isinstance(new_delta, dict) else {}
            new_delta["text"] = out
            new["delta"] = new_delta
            return [_render_frame(parsed.pre, parsed.post, new)]

        if dtype == "input_json_delta":
            piece = delta.get("partial_json")
            if not isinstance(piece, str):
                piece = ""
            block = self._partials.get(idx)
            if block is None:
                block = _PartialBlock(
                    obj=copy.deepcopy(obj), pre=parsed.pre, post=parsed.post
                )
                self._partials[idx] = block
            block.pieces.append(piece)
            block.count += 1
            return []

        if isinstance(dtype, str) and ("thinking" in dtype or "signature" in dtype):
            self._stats["thinking_passthrough"] += 1
            return [raw]
        return [raw]

    def _handle_stop(self, parsed: _ParsedFrame, raw: bytes) -> list[bytes]:
        idx = _index_of(parsed.obj)
        out = self._flush_text_index(idx)
        block = self._partials.pop(idx, None)
        if block is not None:
            out.extend(self._emit_partials(block))
        out.append(raw)
        return out

    # ------------------------------------------------------------------ flushing

    def _flush_text(self) -> list[bytes]:
        out: list[bytes] = []
        for idx in list(self._text):
            out.extend(self._flush_text_index(idx))
        return out

    def _flush_text_index(self, idx: Any) -> list[bytes]:
        channel = self._text.pop(idx, None)
        if channel is None:
            return []
        text = channel.hold.flush()
        if not text:
            return []
        data = copy.deepcopy(channel.template)
        delta = data.get("delta")
        delta = dict(delta) if isinstance(delta, dict) else {}
        delta["text"] = text
        data["delta"] = delta
        return [_render_frame(channel.pre, channel.post, data)]

    def _flush_partials(self) -> list[bytes]:
        out: list[bytes] = []
        for idx in list(self._partials):
            out.extend(self._emit_partials(self._partials.pop(idx)))
        return out

    def _emit_partials(self, block: _PartialBlock) -> list[bytes]:
        raw_json = "".join(block.pieces)
        try:
            parsed = json.loads(raw_json)
        except Exception:
            for _ in _ALIAS_RX.finditer(raw_json):
                self._stats["unresolved"] += 1
            serialized = raw_json
        else:
            serialized = json.dumps(_restore_obj(parsed, self._restore_counted))
        return [
            _render_frame(block.pre, block.post, _with_partial(block.obj, piece))
            for piece in _distribute(serialized, block.count)
        ]

    # ------------------------------------------------------------------ restoring

    def _restore_counted(self, text: str) -> str:
        out = self._restore_fn(text)
        if not isinstance(out, str):  # defensive: restore must return str
            out = str(out)
        if out != text:
            self._stats["restored"] += 1
        if out:
            for _ in _ALIAS_RX.finditer(out):
                self._stats["unresolved"] += 1
        return out


def _restore_obj(obj: Any, restore: Callable[[str], str]) -> Any:
    """Recursively restore string *values* (never dict keys)."""
    if isinstance(obj, str):
        return restore(obj)
    if isinstance(obj, dict):
        return {key: _restore_obj(value, restore) for key, value in obj.items()}
    if isinstance(obj, list):
        return [_restore_obj(item, restore) for item in obj]
    return obj


def _with_partial(template: dict[str, Any], piece: str) -> dict[str, Any]:
    data = copy.deepcopy(template)
    delta = data.get("delta")
    delta = dict(delta) if isinstance(delta, dict) else {}
    delta["partial_json"] = piece
    data["delta"] = delta
    return data
