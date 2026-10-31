# PII Proxy (v2)

本机脱敏网关：在请求离开本机前，把敏感值替换为**确定性可读别名**；在响应返回客户端前，按协议（SSE 事件 / JSON 字段）精确还原。

## 为什么是 v2

v1 使用不透明密文 `<PII:TYPE>AES密文</PII>` + 响应侧正则扫 tag 裸替换，实测有若干结构性问题（issue #24）：模型改写占位符即永久不可还原；真实流式分块切在占位符内部会漏还原；明文含引号/反斜杠时把 SSE 帧写成非法 JSON；会改写带签名的 thinking 块。v2 换成：

* **确定性别名**：`PII_<KIND>_<6hex>`，字母表 `[A-Za-z0-9_]`，不含 `< > " \ { }`，不需要任何转义；同一真值永远同一个别名（跨重启稳定）。
* **精确映射还原**：查表替换，不再依赖模型逐字回显一个不可理解字符串，也不再扫 tag。
* **事件级流式还原**：按空行切 SSE 帧 → 解析 JSON → 只改应当改的字段 → `json.dumps` 重新序列化；跨帧 half-placeholder 由定长扣留（默认 48 字符）兜住。
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
* `tests/test_stream.py`：任意切分输出一致、JSON 合法性（含引号/反斜杠/换行）、占位符跨帧、`input_json_delta` 累积还原、thinking/signature 透传。
* `tests/test_proxy_v2.py`：请求脱敏覆盖（嵌套 tool_use / tool_result / system list）、响应还原、签名块豁免、fail-open。