# PII Proxy v2 设计（2026-10-31）

> 对应 issue #24。取代 `docs/superpowers/specs/2026-05-16-pii-proxy-design.md` 中的实现方案（那份文档描述的方向仍然成立：请求前脱敏、响应后还原；不成立的是它的实现形态）。

## 1. 根因

v1 的还原通道是「模型逐字回显一个**不透明密文 blob**」×「响应侧对**裸字节流做正则替换**」。两边都不可靠：

* 模型会改写占位符（加空格、`\u003c` 转义、大小写、拆分、截断）——实测 9 种常见改写中 4 种无法还原；
* SSE 是分块到达的字节流，扣留判据只有 `rfind("<PII:")`，切点落在 `<`/`<P`/`<PI` 上就漏；
* 裸替换不做 JSON 转义，明文含 `"` / `\` / 换行时把 SSE 帧写成非法 JSON；
* 正则不区分字段语义，会把带签名的 thinking 文本一起改写，导致会话与签名不再自洽；
* 误伤高（关键词 gate 只认 PASSWORD，`minimum`/`getpass` 被替换）、膨胀 10.7×。

## 2. 目标

1. 正确性：任意分块切分、任意转义形态下，客户端拿到的文本与整段处理逐字节一致；不把占位符残留写进文件/命令/会话。
2. 性能：4KB 块 + 200 条规则，增量扫描 p95 不超过 5ms；无重扫；无 ReDoS。
3. 可观测：基准基线进仓库。
4. 分层：T0 字面 / T1 正则默认开，T2 NER 默认关。

## 3. 架构

```
Claude Code CLI ──POST /v1/messages──▶ pii_proxy.py
                                        │  1. 正则/字面检测（pii_detect.py）
                                        │  2. 真值 -> 确定性别名（pii_vault.py）
                                        ▼
                                  上游（cc-switch / Anthropic）
                                        │  SSE 事件流
                                        ▼
     pii_stream.py：按空行切帧 -> 解析 JSON -> 只改 text_delta / 工具参数 -> json.dumps 重发
```

模块职责：

| 文件 | 职责 |
|---|---|
| `pii_detect.py` | T0 字面（精确、可选边界）+ T1 有界正则；增量扫描；正则体检；锚点预过滤 |
| `pii_vault.py` | HMAC 确定性别名 `PII_<KIND>_<hex6>`；映射持久化（0600）；精确还原；递归还原并跳过签名键 |
| `pii_stream.py` | `TextHold` 定长扣留 + `SSERestorer` 事件级还原（含 `input_json_delta` 累积到 `content_block_stop` 后按帧数切回） |
| `pii_proxy.py` | FastAPI 应用；请求递归脱敏；响应分流（SSE / JSON）；统计与 UI 兼容端点 |

## 4. 关键设计决策

### 4.1 别名而不是密文

`PII_<KIND>_<6hex>`，字母表 `[A-Za-z0-9_]`：不含 `< > " \ { }`，因此不需要任何转义，也不会被模型当作“可计算的数字”。同一 `(kind, value)` 通过 `HMAC(secret, kind||0||value)` 恒定映射到同一别名，跨重启稳定（secret 存在 vault 文件里）。还原是查表，不依赖模型逐字回显密文。

### 4.2 流式：定长扣留 + 事件级还原

* **帧缓冲**：按空行切完整 SSE 帧，半截帧跨 chunk 缓冲（UTF-8 增量解码）。
* **文本通道**：`TextHold` 扣住末尾最多 48 字符；只有完整别名才可能被替换，因此把“别名最大长度”作为扣留上界即可，不需要 AC 自动机（占位符不含会诱发转义的字符，maskit 那套 `_PARTIAL_RX` 转义形态在这里不存在）。
* **工具参数**：`input_json_delta` 原样累积、不转发；`content_block_stop` 时解析成 JSON、只还原字符串值、`json.dumps` 后**按原帧数量切回**，保证客户端进度与顺序不变。
* **重序列化**：所有被改动的帧都用 `json.dumps` 重发，从根上杜绝非法 JSON。
* **签名块**：`thinking` / `signature` / `redacted_thinking` / `encrypted_content` 既不脱敏也不还原，只计数上报。

### 4.3 检测分层

* **T0**：用户在 `~/.pii-proxy/secrets.json` 里声明的真实值（密码、用户名、内网主机），精确匹配、可选大小写、短值强制边界。
* **T1**：内置有界正则（邮箱 / AWS / JWT / PEM / 带凭据 URL / GitHub token / `password=` 类 / IPv4 / 手机号 / 身份证）。每条必须有 `max_len` 上界；导入时做静态体检（拒绝嵌套量词、反向引用、无界 lookaround）；扫描时先用从正则提取的锚点字面量定位候选，再在候选附近窗口跑正则。
* **T2**：presidio/spacy NER，默认关闭（保持默认路径零 ML 依赖）。

### 4.4 扫描必须是增量的

维护 `consumed` 偏移，只扫 `buf[max(0, consumed - (max_len - 1)):]`。实测全量重扫在 360KB/10 条规则、1KB 块下是 33 秒（96.7 s/MB），增量是 0.1 秒（0.31 s/MB），且重扫会把同一匹配重复计数。

### 4.5 失败策略

解析/检测异常一律 fail-open（原样转发）并计数；绝不让代理自身成为请求失败的原因。

## 5. 基准与验收

`npm run bench:pii`（`server/pii-proxy/bench/bench_pii.py`）输出：扫描吞吐（增量 vs 全量重扫反例）、SSE 吞吐与每块 p50/p95 延迟、全部切点 fuzz（任意切分输出一致）。`--json bench/baseline.json` 落基线。

验收：

1. `tests/test_detect.py` / `tests/test_stream.py` / `tests/test_proxy_v2.py` 全绿；
2. 全部切点 fuzz `mismatches == 0`；
3. 4KB 块 + 200 规则增量扫描 p95 <= 5ms；SSE 单块处理 p95 <= 5ms；
4. 请求侧明文出网叶子节点为 0（嵌套 tool_use / tool_result / system list 均覆盖），图片等二进制计入 `uncovered_binary` 并告警。

## 6. 参考

同类项目调研见 issue #24 第 7 节：maskit（事件解析 + `_PARTIAL_RX` 扣留）、veil（确定性假名 + `TextHold` + 写文件 sink 策略）、pasteguard（`distributeJson`）、PrivAiTe（Trie holdback + thinking verbatim）。本设计与它们的共识一致：不透明密文 + 正则扫 tag 不是可用的还原通道。