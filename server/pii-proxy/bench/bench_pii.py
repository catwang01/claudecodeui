#!/usr/bin/env python3
"""Benchmarks for the PII proxy v2 (issue #24).

Run:  npm run bench:pii          (from the repo root)
      ./venv/bin/python3 bench/bench_pii.py --json bench/baseline.json

What is measured (the numbers that matter for a local streaming proxy):

* scan_naive  - rescanning the whole accumulated buffer per chunk. This is the
  shape that made v1 slow (order of 96 s/MB on 1 KB chunks) and it is kept here
  as the regression counter-example;
* scan_incr   - incremental scan over the new window only, i.e. the supported
  path Detector.scan_window;
* sse_restore - end-to-end SSE frame restore throughput plus the added latency
  per 4 KB chunk caused by the hold-back window;
* split_fuzz  - every possible cut point must give byte-identical output to a
  single-shot feed.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import tempfile
import time
from typing import Callable

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pii_detect import Detector, DetectorConfig, PatternSpec  # noqa: E402
from pii_stream import SSERestorer  # noqa: E402
from pii_vault import Vault  # noqa: E402

random.seed(7)
WORDS = ["deploy", "config", "service", "handler", "cluster", "pipeline", "record", "session", "bundle", "queue"]


def make_corpus(size: int, secrets: list) -> str:
    parts, total = [], 0
    while total < size:
        line = " ".join(random.choice(WORDS) for _ in range(random.randint(6, 12)))
        parts.append(line)
        total += len(line) + 1
        if random.random() < 0.002:
            secret = random.choice(secrets)
            parts.append(secret)
            total += len(secret) + 1
    return "\n".join(parts)


def make_detector(n_literals: int, n_patterns: int):
    secrets = ["S3CR3T_%05d_%s" % (i, random.choice(WORDS)) for i in range(n_literals)]
    all_patterns = [
        PatternSpec("EMAIL_ADDRESS", r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}", 128, False),
        PatternSpec("AWS_KEY", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", 64, True),
        PatternSpec("JWT_TOKEN", r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b", 4096, True),
        PatternSpec("IPV4", r"\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b", 32, True),
        PatternSpec("CN_MOBILE", r"\b(?:\+?86[- ]?)?1[3-9]\d{9}\b", 32, True),
    ]
    patterns = all_patterns[: max(1, min(n_patterns, len(all_patterns)))]
    cfg = DetectorConfig(literals=[("LITERAL", s) for s in secrets], patterns=patterns)
    return Detector(cfg), secrets


def best(fn: Callable[[], object], repeat: int = 3) -> float:
    timings = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        fn()
        timings.append(time.perf_counter() - t0)
    return min(timings)


def bench_scan(det: Detector, corpus: str, chunk: int) -> dict:
    prefix = min(len(corpus), max(chunk * 64, 65536))

    def naive_prefix() -> int:
        buf, hits = "", 0
        for i in range(0, prefix, chunk):
            buf += corpus[i:i + chunk]
            hits += len(det.scan(buf))
        return hits

    def incr() -> int:
        buf, consumed, hits = "", 0, 0
        for i in range(0, len(corpus), chunk):
            buf += corpus[i:i + chunk]
            matches, consumed = det.scan_window(buf, consumed)
            hits += len(matches)
        return hits

    t_naive_prefix = best(naive_prefix, repeat=1)
    t_incr = best(incr)
    mb = max(len(corpus) / 1048576, 1e-9)
    return {
        "chunk_bytes": chunk,
        "naive_prefix_bytes": prefix,
        "naive_ms_extrapolated": round(t_naive_prefix * 1000 * (len(corpus) / prefix), 1),
        "incr_ms": round(t_incr * 1000, 2),
        "incr_ms_per_mb": round(t_incr * 1000 / mb, 2),
    }


def bench_sse(corpus: str, vault: Vault, chunk: int) -> dict:
    text = corpus[:200000]
    events = []
    for i in range(0, len(text), 240):
        events.append(json.dumps({"type": "content_block_delta", "index": 0,
                                  "delta": {"type": "text_delta", "text": text[i:i + 240]}}))
    payload = ("data: " + "\n\ndata: ".join(events) + "\n\ndata: [DONE]\n\n").encode()

    def run() -> int:
        restorer = SSERestorer(vault.restore_text, 48)
        out = 0
        for i in range(0, len(payload), chunk):
            out += sum(len(f) for f in restorer.feed(payload[i:i + chunk]))
        out += sum(len(f) for f in restorer.flush())
        return out

    per_chunk = []
    restorer = SSERestorer(vault.restore_text, 48)
    for i in range(0, len(payload), chunk):
        t0 = time.perf_counter()
        restorer.feed(payload[i:i + chunk])
        per_chunk.append((time.perf_counter() - t0) * 1000)
    restorer.flush()
    per_chunk.sort()
    t = best(run)
    return {
        "chunk_bytes": chunk,
        "payload_bytes": len(payload),
        "total_ms": round(t * 1000, 2),
        "mb_per_s": round(len(payload) / 1048576 / max(t, 1e-9), 1),
        "chunk_ms_p50": round(statistics.median(per_chunk), 3),
        "chunk_ms_p95": round(per_chunk[min(len(per_chunk) - 1, int(len(per_chunk) * 0.95))], 3),
    }


def bench_split_fuzz(vault: Vault) -> dict:
    text = "here: " + vault.alias_for("LITERAL", "S3CR3T_fuzz_value") + " end"
    payload = ("data: " + json.dumps({"type": "content_block_delta", "index": 0,
                                      "delta": {"type": "text_delta", "text": text}}) + "\n\n").encode()

    def restore_all(chunks: list) -> bytes:
        restorer = SSERestorer(vault.restore_text, 48)
        out = b"".join(b"".join(restorer.feed(c)) for c in chunks)
        return out + b"".join(restorer.flush())

    baseline = restore_all([payload])
    mismatches = 0
    for cut in range(1, len(payload)):
        if restore_all([payload[:cut], payload[cut:]]) != baseline:
            mismatches += 1
    return {"cut_points": len(payload) - 1, "mismatches": mismatches,
            "restored_ok": b"S3CR3T_fuzz_value" in baseline}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", dest="json_path", default=None)
    ap.add_argument("--literals", type=int, default=50)
    ap.add_argument("--patterns", type=int, default=5)
    ap.add_argument("--corpus-mb", type=float, default=0.36)
    args = ap.parse_args()

    det, secrets = make_detector(args.literals, args.patterns)
    corpus = make_corpus(int(args.corpus_mb * 1048576), secrets)
    vault = Vault(os.path.join(tempfile.mkdtemp(prefix="pii-bench-"), "vault.json"), secret=b"b" * 32)

    results = {"literals": args.literals, "patterns": args.patterns,
               "corpus_bytes": len(corpus), "scan": [], "sse": [], "split_fuzz": {}}
    print("corpus=%d B  literals=%d  patterns=%d  max_len=%d" % (len(corpus), args.literals, args.patterns, det.max_len))
    for chunk in (1024, 4096, 16384):
        row = bench_scan(det, corpus, chunk)
        results["scan"].append(row)
        print("  scan  chunk=%6dB  incr=%7.2f ms (%7.2f ms/MB)   naive(extrapolated)=%9.1f ms" % (
            chunk, row["incr_ms"], row["incr_ms_per_mb"], row["naive_ms_extrapolated"]))
    for chunk in (4096,):
        row = bench_sse(corpus, vault, chunk)
        results["sse"].append(row)
        print("  sse   chunk=%6dB  %8.2f MB/s   p50=%.3f ms  p95=%.3f ms" % (
            chunk, row["mb_per_s"], row["chunk_ms_p50"], row["chunk_ms_p95"]))
    fuzz = bench_split_fuzz(vault)
    results["split_fuzz"] = fuzz
    print("  fuzz  cut_points=%d  mismatches=%d  restored=%s" % (
        fuzz["cut_points"], fuzz["mismatches"], fuzz["restored_ok"]))

    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(results, fh, ensure_ascii=False, indent=2)
        print("wrote " + args.json_path)
    return 1 if (fuzz["mismatches"] or not fuzz["restored_ok"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
