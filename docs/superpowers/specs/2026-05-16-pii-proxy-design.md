# PII Proxy 设计文档

**日期**: 2026-05-16  
**状态**: 已实现（2026-05-16）

## 背景

claudecodeui 作为 Claude Code CLI 的 Web UI，用户的聊天消息和工具读取的文件内容都会原文发送给 Anthropic API。为防止 PII（个人身份信息）暴露给大模型，需要在请求进入 Anthropic API 之前完成脱敏，在响应返回给前端之前完成还原。

## 目标

- 用户聊天消息和工具返回的文件内容中的 PII 在到达 Anthropic API 之前被加密替换
- LLM 响应中的加密 token 在返回前端之前被还原为原始值
- 对现有代码改动最小，不破坏现有功能

## 范围

- **支持提供商**: 仅 Claude（通过 `ANTHROPIC_BASE_URL` 控制）
- **流式响应（SSE）**: 暂不处理，直接透传
- **非流式响应**: 完整处理脱敏/还原

## 架构

```
Claude Agent SDK
  ↓  ANTHROPIC_BASE_URL=http://127.0.0.1:18090
┌────────────────────────────────────────────────┐
│  PII Proxy  (Python FastAPI，全局单进程)         │
│                                                │
│  POST /v1/messages (及其他 /v1/* 路径)          │
│                                                │
│  请求: Presidio Analyze → AES Encrypt → 转发   │
│  响应:                                         │
│    - SSE (text/event-stream): 直接透传          │
│    - JSON (application/json): AES Decrypt 还原 │
└────────────────────────────────────────────────┘
  ↓  PII_PROXY_UPSTREAM_URL
Anthropic API (https://api.anthropic.com)
```

启动方式：`npm run dev` / `npm run start` 通过 `concurrently` 同时启动 Node 服务与 Python 代理，无需在 Node 代码中 spawn 进程。

## 请求处理

### 脱敏对象

Anthropic API 请求体中 `messages` 数组的每条消息文本内容，包括：
- `{"role": "user", "content": "string"}` 中的字符串
- `{"role": "user", "content": [{"type": "text", "text": "string"}]}` 中的 text 字段
- `{"role": "tool", "content": [...]}` 中的工具返回文本（文件内容）

### 脱敏方式

使用三层检测合并（Presidio `AnalyzerEngine` + 自定义 `PasswordValueRecognizer` + `detect-secrets`），确定性 AES-CBC 加密替换（HMAC 派生 IV，相同内容产生相同密文）：

```
原文: "密码是 mysecret123，邮箱 foo@bar.com"
脱敏: "密码是 <PII:PASSWORD>AES固定加密串==</PII>，邮箱 <PII:EMAIL_ADDRESS>AES固定加密串==</PII>"
```

使用确定性 AES 加密的原因：加密可逆（还原时无需映射表），且相同明文产生相同密文，方便调试和去重检测。

### 检测实体

默认：`EMAIL_ADDRESS`, `PASSWORD`  
可通过 `PII_PROXY_ENTITIES` 环境变量覆盖。

### 自定义 Recognizer

`PasswordValueRecognizer`：基于正则的密码/密钥检测器，支持英文和中文关键字（`password=`、`api_key=`、`密码是`等结构化和自然语言模式）。通过 `_analyzer.registry.add_recognizer()` 注册到 Presidio 引擎。

## 响应处理

| 响应类型 | 处理方式 |
|---------|---------|
| `application/json` | 解析 JSON，对文本字段递归运行 `DeanonymizeEngine` 解密还原，返回还原后的 JSON |
| `text/event-stream` (SSE) | 直接透传，不处理 |

非流式场景下，还原的目标字段为响应体中所有出现 `<ENTITY>...</ENTITY>` 模式的文本。

## 文件结构

```
server/pii-proxy/
├── pii_proxy.py        # FastAPI 代理主体
├── test_pii_proxy.py   # pytest 测试套件（10 tests，mocks Presidio）
├── requirements.txt    # 依赖声明
└── setup.sh            # 一键安装脚本（pip install + spacy model download）
```

### requirements.txt

```
presidio-analyzer==2.2.354
fastapi==0.115.12
uvicorn[standard]==0.34.2
httpx==0.28.1
cryptography==44.0.3
spacy>=3.7,<3.8
detect-secrets>=1.5.0
```

## 配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `ANTHROPIC_BASE_URL` | Node SDK 指向的代理地址 | `http://127.0.0.1:18090` |
| `PII_PROXY_UPSTREAM_URL` | 代理转发的真实 API 地址（显式覆盖） | 自动从 `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL` 读取；未配置时 `https://api.anthropic.com` |
| `PII_PROXY_AES_KEY` | 64 字符 hex 编码的 AES-256 密钥 | 启动时自动生成，打印到 stdout |
| `PII_PROXY_PORT` | 代理监听端口 | `18090` |
| `PII_PROXY_ENTITIES` | 检测实体类型，逗号分隔 | `EMAIL_ADDRESS,PASSWORD` |

`PII_PROXY_AES_KEY` 在开发环境每次重启都会重新生成（无需持久化）。生产环境应在 `.env` 中固定，否则重启后已发出的加密 token 无法还原。

## package.json 改动

```json
"scripts": {
  "dev": "PII_PROXY_PORT=18090 concurrently --kill-others \"npm run server:dev\" \"npm run client\" \"npm run pii-proxy\"",
  "start": "npm run build && PII_PROXY_PORT=18090 concurrently --kill-others \"npm run server:prod\" \"npm run pii-proxy\"",
  "pii-proxy": "cd server/pii-proxy && python3 -m uvicorn pii_proxy:app --host 127.0.0.1 --port ${PII_PROXY_PORT:-18090} --log-level info"
}
```

**`ANTHROPIC_BASE_URL` 注入方式**：与 tap 相同的 settings 注入，不在 npm script 里硬写环境变量。

tap 的注入路径（`claude-sdk.js:273-282`）：
```javascript
const tapSession = sessionId ? getTapSession(sessionId) : null;
if (tapSession) {
  // 注入到 SDK 调用的 settings.env
  extraArgs.settings = { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${tapSession.proxyPort}` } };
}
```

PII 代理采用同样的模式，在 `claude-sdk.js` 同一位置追加：
```javascript
// 若 PII proxy 正在运行，覆盖 ANTHROPIC_BASE_URL（优先级低于 tap）
if (!tapSession && isPiiProxyEnabled()) {
  extraArgs.settings = { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${PII_PROXY_PORT}` } };
}
```

`isPiiProxyEnabled()` 读取应用设置（settings DB 中 `pii_proxy_enabled` 字段），`PII_PROXY_PORT` 默认 `18090` 可通过环境变量覆盖。

PII 代理启动时通过 `resolveAnthropicBaseUrl()`（已有实现）解析真实上游地址作为转发目标，无需额外配置。

## 代理核心逻辑（pii_proxy.py 伪代码）

```python
@app.api_route("/{path:path}", methods=["GET","POST","PUT","DELETE"])
async def proxy(request: Request, path: str):
    body = await request.body()

    # 仅对 POST /v1/messages 做脱敏
    if request.method == "POST" and path == "v1/messages":
        body = anonymize_request_body(body)

    # 转发到 Anthropic API
    upstream_resp = await client.request(
        method=request.method,
        url=f"{UPSTREAM_URL}/{path}",
        headers=filter_headers(request.headers),
        content=body,
    )

    content_type = upstream_resp.headers.get("content-type", "")

    # SSE 直接透传
    if "text/event-stream" in content_type:
        return StreamingResponse(upstream_resp.aiter_bytes(), ...)

    # JSON 响应做还原
    resp_body = deanonymize_response_body(upstream_resp.content)
    return Response(content=resp_body, status_code=upstream_resp.status_code, ...)
```

## 不在范围内（后续可扩展）

- SSE 流式响应的逐 token 还原
- Cursor / Codex / Gemini 等其他提供商

## 已实现的扩展

- **PasswordValueRecognizer**（2026-05-16）：自定义 Presidio recognizer，正则匹配 `password=`、`api_key=`、JSON `"password": "..."` 等结构化和自然语言密码模式（含中文 `密码是`、`口令为`）
- **detect-secrets 集成**（2026-05-17）：高精度结构化密钥检测层，覆盖 JWT token（`eyJ...`）、PEM 私钥、AWS Access Key、Basic Auth、带引号的关键词密码。与 Presidio 结果合并并自动去除重叠 span
- **确定性加密**（2026-05-17）：AES-CBC IV 改为 HMAC-SHA256(key, plaintext)[:16] 派生，相同明文始终产生相同密文，便于调试去重
- **精简默认实体**（2026-05-17）：默认检测实体从 `PERSON,PHONE_NUMBER,EMAIL_ADDRESS,CREDIT_CARD,LOCATION` 精简为 `EMAIL_ADDRESS,PASSWORD`，消除 spaCy NER 对技术词汇（命令名、变量名）的误报
