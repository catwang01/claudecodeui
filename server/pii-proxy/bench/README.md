# PII proxy benchmarks

```bash
npm run bench:pii                                  # 默认参数，打印表格
./venv/bin/python3 bench/bench_pii.py --json bench/baseline.json
./venv/bin/python3 bench/bench_pii.py --literals 200 --patterns 5 --corpus-mb 4
```

## 指标

| 名称 | 含义 | 期望 |
|---|---|---|
| scan.incr_ms | 增量扫描（`Detector.scan_window`）处理整段语料耗时 | 随规则数线性，4KB 块 p95 不超过 5ms |
| scan.naive_ms_extrapolated | 每块重扫整个累积缓冲（v1 形态）的对照值 | 只作为回归守卫，必须显著高于增量 |
| sse.mb_per_s / chunk_ms_p95 | SSE 事件级还原吞吐与单块延迟 | p95 不超过 5ms（4KB 块） |
| split_fuzz.mismatches | 每个切点分别喂入 vs 整段一次喂入的输出差异数 | 必须为 0 |

基线文件 `baseline.json` 由 `--json` 生成；换机器后重新生成并记录机型，不要把不同机器的数字混在一起比较。

## 复现 v1 的对照数字

issue #24 记录的历史基线（CPython 3.12 / macOS）：

* 全量重扫：1KB 块 33 219 ms（96.7 s/MB）、4KB 块 3 547 ms、16KB 块 2 009 ms（360KB 语料 / 10 条正则）；
* 增量扫描：105 / 143 / 371 ms；
* 200 条字面：逐条 `str.count` 38-69 ms，合并 alternation 在无共同前缀时反而 707 ms；
* `^(a+)+$` 对 30 个字符超过 5 秒（CPython `re` 无超时且持有 GIL）。