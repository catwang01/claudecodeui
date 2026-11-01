# PII Proxy (v2)

本机脱敏网关：在请求离开本机前，把敏感值替换为**格式一致的确定性假值**（fake surrogate，例如真邮箱 → 假邮箱、真内网 IP → 假私网 IP）；在响应返回客户端前，按协议（SSE 事件 / JSON 字段）精确还原。

## 为什么是 v2

v1 使用不透明密文 `<PII:TYPE>AES密文</PII>` + 响应侧正则扫 tag 裸替换，实测有若干结构性问题（issue #24）：模型改写占位符即永久不可还原；真实流式分块切在占位符内部会漏还原；明文含引号/反斜杠时把 SSE 帧写成非法 JSON；会改写带签名的 thinking 块。v2 换成：

* **格式一致的假值（默认）**：按实体类型生成“像真的”替身，同一真值永远同一个假值（跨重启稳定）。从数据保护角度，模型看到的具体值无关紧要，**只要形状对**；自然文本比不透明 hex token 更容易被模型逐字复制，也更利于它理解格式/长度/语义。
* **可选不透明 token**：`PII_PROXY_PLACEHOLDER_MODE=token` 可退回 `PII_<KIND>_<6hex>` 模式（A/B 对比或排查用）。

| 真值类型 | 假值示例 |
|---|---|
| 邮箱 | `alice.chen@corp.example` → `jordan.kim@example.com` |
| IPv4 | `117.72.145.38` → `10.159.198.181` |
| 手机号 | `13812345678` → `14735370211` |
| AWS key | `AKIA...` → `AKIA` + 16 位随机 |
| JWT | 三段 base64url，长度相近 |
| PEM 私钥 | 同格式假 RSA 私钥（≤256 字符） |
| `password=xxx` | 保留 `password=` 前缀，只换值 |
| 自定义清单值 | 按 kind 生成，或同长度随机串 |
* **精确映射还原**：查表替换，不再依赖模型逐字回显一个不可理解字符串，也不再扫 tag。
* **事件级流式还原**：按空行切 SSE 帧 → 解析 JSON → 只改应当改的字段 → `json.dumps` 重新序列化；跨帧半截占位符由定长扣留兜住（窗口 = 当前最长占位符长度，下限 48 字符）。
* **签名块豁免**：`thinking` / `signature` / `redacted_thinking` / `encrypted_content` 一律不改写。
* **检测分层**：T0 用户字面清单（默认开）→ T1 有界正则（内置，默认开）→ T2 NER（默认关，本版本不内置）。

## 配置

### 用户清单 / 自定义规则：`~/.pii-proxy/secrets.json`

```json
{
  "case_sensitive": false,
  "min_literal_len": 4,
  "literals": [
    {"kind": "PASSWORD", "value": "my-real-password"},
    {"kind": "USERNAME", "value": "edward"},
    {"kind": "INTERNAL_HOST", "value": "db.internal.example"}
  ],
  "patterns": [
    {"kind": "EMPLOYEE_ID", "regex": "\\bEMP-[0-9]{6}\\b", "max_len": 16}
  ]
}
```

* `literals`：你确切知道要保护的**真实值**。短于 `min_literal_len` 的值会被拒绝（避免把常见短词全量替换）。
* `patterns`：可选正则，**必须**能被 `max_len` 界定（无界模式会被体检拒绝），单条不超过 256 字符、最多 100 条。
* 内置 T1 规则（邮箱 / AWS key / JWT / PEM / 带凭据的 URL / GitHub token / password= 类 / IPv4 / 手机号 / 身份证）默认启用；在 `patterns` 里定义同名 `kind` 即可覆盖。

### 机器状态：`~/.pii-proxy/vault.json`（自动生成，0600）

保存 HMAC secret 与 `别名 -> 真值` 映射，使别名跨重启稳定、旧别名仍可还原。**不要提交**。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PII_PROXY_PORT` | 18090 | 监听端口（dev 用 18091） |
| `PII_PROXY_UPSTREAM_URL` | `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL`，否则 `https://api.anthropic.com` | 转发目标 |
| `PII_PROXY_SECRETS_FILE` | `~/.pii-proxy/secrets.json` | 清单/规则文件 |
| `PII_PROXY_VAULT_FILE` | `~/.pii-proxy/vault.json` | 映射持久化文件 |
| `PII_PROXY_PLACEHOLDER_MODE` | `fake` | `fake` = 同格式假值（推荐）；`token` = 旧的不透明 token |

## 运行与验证

```bash
npm run pii-proxy            # 启动（自动使用 venv）
npm run pii-proxy:test       # pytest（tests/ 下三层测试）
npm run bench:pii            # 基准：扫描吞吐 / SSE 吞吐 / 任意切分 fuzz
curl -s localhost:18090/health
```

`/health` 会返回 `mode: v2-aliases`、当前检测器统计、vault 条目数与运行时计数（已脱敏值 / 已还原值 / 未覆盖的二进制 / 跳过的签名块）。`/logs` 与 `/pii-groups` 形状保持不变，设置界面无需改动。

## 保护边界（务必知晓）

* 只保护**清单命中 + 内置正则命中**的内容；没命中的一律原文出网。
* 图片 / 附件 base64、`count_tokens` 以外的非 `/v1/messages` 端点不在脱敏范围内；前者会计入 `stats.uncovered_binary` 并打印 warning。
* 任何解析/检测异常都 **fail-open**（原样转发）并计入统计，不会因为代理出错而阻断请求。
* 别名会以明文形式出现在发送给模型的请求里；vault 文件含真值，按密钥材料对待。

## 测试

```bash
cd server/pii-proxy
./venv/bin/python3 -m pytest tests -q
```

* `tests/test_detect.py`：T0 字面 / T1 正则 / 增量扫描与全量扫描等价 / 体检规则。
```bash
npm run pii-proxy:cov      # 覆盖率 + 未覆盖行
npm run bench:pii          # 基准与切分 fuzz
```

当前基线：**189 passed + 1 xfailed，整体行覆盖 95%**（pii_vault 95% / pii_surrogates 95% / pii_stream 96% / pii_detect 93% / pii_proxy 93%）。未覆盖主要是防御性分支（配置回退、保存失败、上游重试）。

| 测试文件 | 覆盖 |
|---|---|
| `tests/test_detect.py` | T0 字面 / T1 正则 / 增量扫描与全量扫描等价 / 体检规则 / 内置规则必须全部加载且命中样例 / 锚点保守性 |
| `tests/test_stream.py` | 任意切分不变量、JSON 合法性、占位符跨帧、`input_json_delta` 累积还原、thinking/signature 透传 |
| `tests/test_stream_edges.py` | 畸形帧、CRLF、半截 UTF-8、超长/超多帧、转义与嵌套、截断与计数、幂等 |
| `tests/test_proxy_v2.py` | 请求脱敏覆盖（嵌套 tool_use / tool_result / system list）、响应还原、签名块豁免、fail-open |
| `tests/test_proxy_edges.py` | UI 端点形状、统计计数、非 messages 路径不动、非 JSON 透传、错误响应还原、别名跨请求稳定、配置合并 |
| `tests/test_http_e2e.py` | 真实 uvicorn + 真实 HTTP：多轮对话、极端切分、工具调用闭环、特殊字符、上游错误、并发；以及假值形状（邮箱/IP）与 token 模式对照 |
| `tests/test_vault_edges.py` | 假值形状（邮箱/IP/手机/身份证/AWS/GitHub/JWT/PEM/基本认证/密码）、确定性、唯一性、不复用原文、持久化、损坏文件、并发、token 模式兼容、签名键跳过 |

**已知未覆盖**（刻意或待补）：

1. 真实 Claude Code CLI → cc-switch → DeepSeek 链路的会话级验证（需要打开开关 + 真实会话；测试里用假上游代替）。
2. 模型主动改写占位符（加空格 / 大小写 / 截断）后的模糊还原——当前设计不做模糊匹配，截断视为不可恢复。
3. 上游长时间挂起 / 连接中断时的重试与超时行为（会拖慢测试，只在冒烟里手工验证过）。
4. 多进程同时写同一个 vault 文件（当前靠文件替换 + 0600，没有跨进程锁）。
5. CRLF（`\r\n\r\n`）帧分隔不被识别（`tests/test_stream_edges.py` 里标为 xfail 记录该契约缺口）：字节原样透传、不丢数据，但不会还原。当前上游（Anthropic / cc-switch）用 `\n\n`，如需支持 CRLF 上游需在 `pii_stream.py` 的切帧处放宽。