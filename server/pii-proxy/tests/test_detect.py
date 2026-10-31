"""Unit tests for pii_detect (issue #24)."""

from __future__ import annotations

import random

from pii_detect import Detector, DetectorConfig, PatternSpec

SECRETS = [
    ("PASSWORD", "hunter2XYZ"),
    ("USERNAME", "edward"),
    ("INTERNAL_HOST", "db.internal.example"),
]
EMAIL = PatternSpec("EMAIL_ADDRESS", r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}", 128, False)
AWS = PatternSpec("AWS_KEY", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", 64, True)


def make_detector(**kwargs) -> Detector:
    cfg = DetectorConfig(literals=list(SECRETS), patterns=[EMAIL, AWS], **kwargs)
    return Detector(cfg)


def test_literal_and_pattern_matches():
    det = make_detector()
    text = "password=hunter2XYZ mail alice@example.com key AKIAIOSFODNN7EXAMPLE host db.internal.example"
    kinds = sorted(m.kind for m in det.scan(text))
    assert kinds == ["AWS_KEY", "EMAIL_ADDRESS", "INTERNAL_HOST", "PASSWORD"]


def test_case_insensitive_literals_by_default():
    det = make_detector()
    matches = det.scan("HUNTER2XYZ")
    assert [m.kind for m in matches] == ["PASSWORD"]


def test_offset_is_added_to_match_positions():
    det = make_detector()
    matches = det.scan("xx hunter2XYZ", offset=100)
    assert matches[0].start == 103 and matches[0].end == 113


def test_short_literal_is_reported_and_ignored():
    cfg = DetectorConfig(literals=[("SHORT", "abc")], patterns=[], min_literal_len=4)
    det = Detector(cfg)
    assert any("shorter than min_literal_len" in issue for issue in det.health()["issues"])
    assert det.scan("abc abc") == []


def test_lint_rejects_redos_patterns():
    cfg = DetectorConfig(patterns=[PatternSpec("EVIL", r"^(a+)+$", 32)])
    issues = cfg.lint()
    assert any("nested quantifiers" in issue for issue in issues)
    assert Detector(cfg).health()["patterns"] == 0  # rejected, not silently kept


def test_lint_rejects_backreference_and_oversized_pattern():
    cfg = DetectorConfig(patterns=[
        PatternSpec("BACKREF", r"(\w+) \1", 32),
        PatternSpec("LONG", "a" * 300, 300),
        PatternSpec("BAD_SPAN", r"x+", 9999),
    ])
    issues = " ".join(cfg.lint())
    assert "backreference" in issues and "chars long" in issues and "max_len" in issues


def test_too_many_patterns_is_reported():
    cfg = DetectorConfig(patterns=[PatternSpec("P%d" % i, r"x%d" % i, 8) for i in range(101)])
    assert any("too many patterns" in issue for issue in cfg.lint())


def test_overlap_prefers_longest_match():
    cfg = DetectorConfig(literals=[("LONG", "secret-value"), ("SHORT", "secret")], patterns=[])
    matches = Detector(cfg).scan("a secret-value here")
    assert len(matches) == 1 and matches[0].kind == "LONG"


def test_anchor_prefilter_skips_absent_pattern():
    det = make_detector()
    assert det.scan("no keys here") == []
    assert [m.kind for m in det.scan("AKIAIOSFODNN7EXAMPLE")] == ["AWS_KEY"]


def test_max_len_covers_literals_and_patterns():
    det = make_detector()
    assert det.max_len == max(len("db.internal.example"), EMAIL.max_len, AWS.max_len)


def test_scan_window_matches_a_single_full_scan():
    """Incremental scanning must find exactly the same matches as one full scan."""
    det = make_detector()
    text = ("prefix " + "filler " * 40 + "hunter2XYZ " + "filler " * 40 +
            "alice@example.com " + "filler " * 40 + "db.internal.example")
    full = det.scan(text)
    rng = random.Random(11)
    for _ in range(30):
        consumed, buf, found = 0, "", []
        i = 0
        while i < len(text):
            step = rng.randint(1, 40)
            buf += text[i:i + step]
            i += step
            matches, consumed = det.scan_window(buf, consumed)
            found.extend(matches)
        assert [(m.start, m.end, m.kind) for m in found] == [(m.start, m.end, m.kind) for m in full]


def test_scan_window_never_reports_the_same_match_twice():
    det = make_detector()
    text = "hunter2XYZ and hunter2XYZ"
    buf, consumed, found = "", 0, []
    for i in range(len(text)):
        buf += text[i]
        matches, consumed = det.scan_window(buf, consumed)
        found.extend(matches)
    assert len(found) == 2
    assert [m.start for m in found] == [0, 15]


def test_scan_window_handles_shrinking_buffer():
    det = make_detector()
    matches, consumed = det.scan_window("hunter2XYZ", 0)
    assert matches and consumed == 10
    matches, consumed = det.scan_window("hunt", 10)
    assert matches == [] and consumed == 4


def test_config_load_roundtrip(tmp_path):
    path = tmp_path / "secrets.json"
    path.write_text(
        '{"case_sensitive": true, "literals": [{"kind": "PASSWORD", "value": "topsecret"}],'
        ' "patterns": [{"kind": "EMP", "regex": "EMP-[0-9]{4}", "max_len": 12}]}',
        encoding="utf-8",
    )
    cfg = DetectorConfig.load(str(path))
    det = Detector(cfg)
    assert [m.kind for m in det.scan("topsecret EMP-1234")] == ["PASSWORD", "EMP"]


def test_config_load_missing_file_is_empty():
    cfg = DetectorConfig.load("/nonexistent/pii-secrets.json")
    assert cfg.literals == [] and cfg.patterns == []
