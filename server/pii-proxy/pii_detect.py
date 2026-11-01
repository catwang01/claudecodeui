"""Deterministic detectors for the PII proxy v2 (issue #24).

Two tiers, no ML in the default path:

* T0 - user supplied literal values (passwords, usernames, internal hosts).
  Exact match (optionally case-insensitive).
* T1 - bounded built-in regexes (emails, keys, tokens ...). Every pattern must
  declare an upper bound on its match length: that bound is what lets the
  streaming layer hold back a bounded tail, and it is also what keeps a
  user-supplied regex from becoming a ReDoS hole.

Scanning is incremental by design: callers keep a consumed offset and call
scan_window, so every byte is visited a bounded number of times. The naive
"rescan the whole buffer per chunk" shape is roughly 300x slower and is kept as
a benchmark counter-example, see bench/bench_pii.py.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Iterable

MAX_PATTERN_LEN = 256
MAX_PATTERNS = 100
# Upper bound for the incremental scan-overlap window. Long-form patterns (PEM
# keys, JWTs) legitimately need a big bound; the streaming hold-back is bounded
# by alias length instead (pii_proxy.RESTORE_MAX_LEN), so this only costs scan
# time, and only when such a pattern's anchor is actually present.
MAX_PATTERN_SPAN = 8192
MAX_DEFAULT_SPAN = 512


@dataclass(frozen=True)
class Match:
    start: int
    end: int
    kind: str
    value: str


@dataclass
class PatternSpec:
    kind: str
    regex: str
    max_len: int = MAX_DEFAULT_SPAN
    case_sensitive: bool = True


@dataclass
class DetectorConfig:
    literals: list[tuple[str, str]] = field(default_factory=list)
    patterns: list[PatternSpec] = field(default_factory=list)
    case_sensitive: bool = False
    min_literal_len: int = 4

    @staticmethod
    def load(path: str | None) -> "DetectorConfig":
        if not path:
            return DetectorConfig()
        try:
            with open(os.path.expanduser(path), "r", encoding="utf-8") as fh:
                raw = json.loads(fh.read())
        except FileNotFoundError:
            return DetectorConfig()
        except Exception:
            return DetectorConfig()
        literals: list[tuple[str, str]] = []
        for item in raw.get("literals", []):
            if isinstance(item, dict) and item.get("value"):
                literals.append((str(item.get("kind") or "LITERAL"), str(item["value"])))
            elif isinstance(item, str) and item:
                literals.append(("LITERAL", item))
        patterns: list[PatternSpec] = []
        for item in raw.get("patterns", []):
            if not isinstance(item, dict) or not item.get("regex"):
                continue
            patterns.append(PatternSpec(
                kind=str(item.get("kind") or "PATTERN"),
                regex=str(item["regex"]),
                max_len=int(item.get("max_len") or MAX_DEFAULT_SPAN),
                case_sensitive=bool(item.get("case_sensitive", True)),
            ))
        return DetectorConfig(
            literals=literals,
            patterns=patterns,
            case_sensitive=bool(raw.get("case_sensitive", False)),
            min_literal_len=int(raw.get("min_literal_len", 4)),
        )

    def lint(self) -> list[str]:
        issues: list[str] = []
        seen: set[str] = set()
        for kind, value in self.literals:
            if value in seen:
                issues.append("duplicate literal value for kind %s" % kind)
            seen.add(value)
            if len(value) < self.min_literal_len:
                issues.append("literal %r (kind %s) is shorter than min_literal_len=%d and will be ignored"
                              % (value, kind, self.min_literal_len))
        if len(self.patterns) > MAX_PATTERNS:
            issues.append("too many patterns: %d (max %d)" % (len(self.patterns), MAX_PATTERNS))
        for spec in self.patterns:
            issues.extend(_lint_pattern(spec))
        return issues


_NESTED_QUANT = re.compile(r"\([^()]*[*+][^()]*\)\s*[*+]")
_BACKREF = re.compile(r"\\[1-9]")


def _lint_pattern(spec: PatternSpec) -> list[str]:
    issues: list[str] = []
    if len(spec.regex) > MAX_PATTERN_LEN:
        issues.append("pattern %s is %d chars long (max %d)" % (spec.kind, len(spec.regex), MAX_PATTERN_LEN))
    if spec.max_len <= 0 or spec.max_len > MAX_PATTERN_SPAN:
        issues.append("pattern %s has max_len=%s outside 1..%d" % (spec.kind, spec.max_len, MAX_PATTERN_SPAN))
    if _NESTED_QUANT.search(spec.regex):
        issues.append("pattern %s contains nested quantifiers (ReDoS risk)" % spec.kind)
    if _BACKREF.search(spec.regex):
        issues.append("pattern %s contains a backreference (unsupported)" % spec.kind)
    try:
        re.compile(spec.regex, 0 if spec.case_sensitive else re.IGNORECASE)
    except re.error as exc:
        issues.append("pattern %s does not compile: %s" % (spec.kind, exc))
    return issues


def _literal_run(regex: str) -> str | None:
    """Longest required literal in a regex, used as a cheap anchor prefilter.

    Deliberately conservative. A wrong anchor silently skips a pattern, i.e.
    leaks the data we are protecting, so character classes and escapes are
    removed before the runs are taken, and a pattern gets no anchor at all
    whenever the literal it would key on may be absent from a match:

    * alternation (``|``) - the "literal" may belong to another branch;
    * optional / zero-or-more constructs (``?``, ``*``) - the literal may be
      matched zero times;
    * a zero-bounded repeat (``{0}``, ``{0,n}``, ``{0,}``) applied to an
      element that can contribute a literal - that literal becomes optional.

    Repeats of a stripped character class or escape (``[A-Z ]{0,40}``) are
    harmless: that element yields no run, so the anchor still comes from a
    required literal elsewhere.
    """
    if "|" in regex:
        return None
    stripped = re.sub(r"\\.", " ", regex)
    stripped = re.sub(r"\[[^\]]*\]", " ", stripped)
    if "?" in stripped or "*" in stripped:
        return None
    if re.search(r"[A-Za-z0-9_)]\{\s*0", stripped):
        return None
    stripped = re.sub(r"\{\d+,?\d*\}", " ", stripped)
    runs = re.findall(r"[A-Za-z0-9_]{3,}", stripped)
    runs = [r for r in runs if r.upper() not in {"BEGIN", "END"}]
    if not runs:
        return None
    return max(runs, key=len)


class Detector:
    def __init__(self, cfg: DetectorConfig) -> None:
        self.cfg = cfg
        self._issues = cfg.lint()
        flags = 0 if cfg.case_sensitive else re.IGNORECASE
        self._literals: list[tuple[str, str]] = []
        for kind, value in cfg.literals:
            if len(value) < cfg.min_literal_len or len(value) == 1:
                continue
            self._literals.append((kind, value))
        self._literal_rx = None
        self._literal_kind: dict[str, str] = {}
        if self._literals:
            pattern = "|".join(re.escape(v) for _, v in sorted(self._literals, key=lambda kv: len(kv[1]), reverse=True))
            self._literal_rx = re.compile(pattern, flags)
            for kind, value in self._literals:
                self._literal_kind[value if cfg.case_sensitive else value.lower()] = kind
        self._patterns: list[tuple[PatternSpec, "re.Pattern[str]", str | None, bool]] = []
        for spec in cfg.patterns:
            if any(issue.startswith("pattern %s " % spec.kind) for issue in self._issues):
                continue
            try:
                compiled = re.compile(spec.regex, 0 if spec.case_sensitive else re.IGNORECASE)
            except re.error:
                continue
            anchor = _literal_run(spec.regex)
            # The anchor check is as substring ``in`` test, so it must follow
            # the pattern's case setting: fold the anchor (and the haystack)
            # for IGNORECASE patterns, otherwise a lower-case match would be
            # skipped and leak.
            fold = not spec.case_sensitive
            if anchor is not None and fold:
                anchor = anchor.lower()
            self._patterns.append((spec, compiled, anchor, fold))

    @property
    def issues(self) -> list[str]:
        return list(self._issues)

    @property
    def _literal_max(self) -> int:
        return max((len(v) for _, v in self._literals), default=1)

    @property
    def max_len(self) -> int:
        longest = max((len(v) for _, v in self._literals), default=0)
        spans = [spec.max_len for spec, _, _, _ in self._patterns]
        return max([longest] + spans + [1])

    def health(self) -> dict:
        return {
            "literals": len(self._literals),
            "patterns": len(self._patterns),
            "skipped_literals": len(self.cfg.literals) - len(self._literals),
            "max_len": self.max_len,
            "issues": list(self._issues),
        }

    def scan(self, text: str, offset: int = 0) -> list[Match]:
        found: list[Match] = []
        if self._literal_rx is not None:
            for m in self._literal_rx.finditer(text):
                value = m.group(0)
                key = value if self.cfg.case_sensitive else value.lower()
                kind = self._literal_kind.get(key, "LITERAL")
                found.append(Match(offset + m.start(), offset + m.end(), kind, value))
        folded = text.lower()
        for spec, rx, anchor, fold in self._patterns:
            if anchor is not None and anchor not in (folded if fold else text):
                continue
            for m in rx.finditer(text):
                value = m.group(0)
                if value:
                    found.append(Match(offset + m.start(), offset + m.end(), spec.kind, value))
        return _dedupe(found)

    def _overlap(self, buf: str) -> int:
        """Overlap needed so a match straddling the previous cut is still seen.

        Long-form patterns only matter when their anchor is present, so the
        window stays small in the common case; otherwise one 4 KB pattern would
        make every 1 KB chunk rescan 4 KB.
        """
        overlap = self._literal_max
        folded = buf.lower()
        for spec, _rx, anchor, fold in self._patterns:
            if anchor is None or anchor in (folded if fold else buf):
                overlap = max(overlap, spec.max_len)
        return max(1, overlap)

    def scan_window(self, buf: str, consumed: int) -> tuple[list[Match], int]:
        """Incremental scan: only the new region plus a bounded overlap window."""
        if consumed > len(buf):
            consumed = 0
        start = max(0, consumed - (self._overlap(buf) - 1))
        matches = self.scan(buf[start:], offset=start)
        fresh = [m for m in matches if m.end > consumed]
        return fresh, len(buf)


def _dedupe(matches: Iterable[Match]) -> list[Match]:
    ordered = sorted(matches, key=lambda m: (m.start, -(m.end - m.start)))
    out: list[Match] = []
    for match in ordered:
        if out and match.start < out[-1].end:
            continue
        out.append(match)
    return out
