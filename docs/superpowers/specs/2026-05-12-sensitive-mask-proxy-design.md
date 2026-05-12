# Sensitive Data Masking Proxy - Design Spec

**Date**: 2026-05-12  
**Status**: Approved

---

## Overview

Add a feature to protect sensitive information in prompts from being sent to AI providers (Anthropic, etc.). A local HTTP proxy intercepts all SDK API calls, masks sensitive patterns before forwarding to the real endpoint, and unmasks the response before returning to the SDK. The user sees original data in the UI; only the AI provider receives sanitized data.

---

## Architecture

```
User Prompt
    |
    v
[claude-agent-sdk] (ANTHROPIC_BASE_URL=http://localhost:3099)
    |
    v
[SensitiveProxy :3099]              <-- new
  |-- parse request JSON body
  |-- mask(text, sessionMapping)    --> replace matches with __MASK_TYPE_N__
  |-- forward to https://api.anthropic.com (real API)
  |-- SSE response: unmask each data chunk
  |-- return restored stream to SDK
    |
    v
Frontend sees original data
```

Key properties:
- Proxy runs in the same Node.js process as the main Express server (no separate process)
- Coverage: initial prompt + system prompt + tool call results + file contents read by AI
- Session-level mapping: same value in the same session always maps to the same placeholder (multi-turn consistency)
- Controlled by a user-level setting (`sensitive_mask_enabled`, default: `true`)

---

## Sensitive Data Patterns

Built-in patterns (all configurable - users can disable individual ones or add custom patterns):

| Type | Pattern Example | Placeholder Format |
|------|-----------------|--------------------|
| Anthropic API Key | `sk-ant-api03-xxx` | `__MASK_ANTHROPIC_KEY_N__` |
| OpenAI API Key | `sk-proj-xxx`, `sk-xxx` | `__MASK_OPENAI_KEY_N__` |
| GitHub Token | `ghp_xxx`, `github_pat_xxx` | `__MASK_GH_TOKEN_N__` |
| Bearer Token | `Bearer eyJxxx` | `__MASK_BEARER_N__` |
| Generic API Key (key=value) | `api_key=abc123` | `__MASK_API_KEY_N__` |
| Credit Card Number | `4111-1111-1111-1111` | `__MASK_CREDIT_CARD_N__` |
| Chinese ID Number | 18-digit format | `__MASK_ID_NUMBER_N__` |
| Chinese Phone Number | `138xxxxxxxx` | `__MASK_PHONE_N__` |

Custom patterns: user-defined regex strings stored as JSON array in `user_settings`.

---

## Session Mapping

- Each active session maintains a `Map<placeholder, originalValue>` stored in memory
- Keyed off the session ID (passed as `X-Mask-Session-Id` request header from SDK options)
- Same sensitive value within a session always maps to the same numbered placeholder
- Mapping cleared when session ends (on session removal from `activeSessions`)
- If no session ID is present in the request, a per-request (ephemeral) mapping is used

---

## User Settings

Stored in the existing `user_settings` SQLite table (key/value per user):

| Key | Default | Description |
|-----|---------|-------------|
| `sensitive_mask_enabled` | `"true"` | Master toggle for the feature |
| `sensitive_mask_custom_patterns` | `"[]"` | JSON array of user-defined regex strings |
| `sensitive_mask_disabled_builtins` | `"[]"` | JSON array of builtin type names to disable |

---

## REST API

Appended to `server/routes/settings.js`:

```
GET  /settings/sensitive-mask
     Response: { enabled: bool, customPatterns: string[], disabledBuiltins: string[] }

POST /settings/sensitive-mask
     Body:     { enabled?: bool, customPatterns?: string[], disabledBuiltins?: string[] }
     Response: { ok: true }
```

Both endpoints require authentication (same auth middleware as existing settings routes).

---

## New Files

### `server/sensitive-masker.js`

Responsibilities:
- Define built-in pattern list (name, regex, placeholder prefix)
- `mask(text, sessionMapping, userSettings)` - find matches, assign/reuse placeholders, return masked text
- `unmask(text, sessionMapping)` - replace all `__MASK_*__` tokens with original values
- `getActivePatterns(userSettings)` - built-ins minus disabled, plus custom patterns
- In-memory session mapping store: `Map<sessionId, Map<placeholder, original>>`
- `createSessionMapping(sessionId)` / `clearSessionMapping(sessionId)`

### `server/sensitive-proxy.js`

Responsibilities:
- Export `startSensitiveProxy(port)` - creates and starts an HTTP server
- On each request:
  1. Read full request body
  2. Extract session ID from `X-Mask-Session-Id` header
  3. Load user settings (from db, cached per request)
  4. Call `masker.mask()` on all string fields in the JSON body (recursive)
  5. Forward request to `https://api.anthropic.com` with original auth headers preserved
  6. If response is SSE (streaming): pipe through chunk-by-chunk, calling `masker.unmask()` on each `data:` line before writing
  7. If response is plain JSON: unmask full body, return
- Export `stopSensitiveProxy()` for graceful shutdown

---

## Modified Files

### `server/index.js`

- On server startup: call `startSensitiveProxy(SENSITIVE_PROXY_PORT)` (default port 3099, configurable via `SENSITIVE_PROXY_PORT` env var)
- On `removeSession(sessionId)`: call `masker.clearSessionMapping(sessionId)`

### `server/claude-sdk.js`

In `queryClaudeSDK()`, before building `sdkOptions`:
1. Load user's `sensitive_mask_enabled` setting from db
2. If enabled: pass `apiUrl: 'http://localhost:3099'` in `sdkOptions` (claude-agent-sdk option, avoids global env var mutation which would cause race conditions with concurrent sessions)
3. Pass session ID via `sdkOptions.headers: { 'X-Mask-Session-Id': sessionId }` so the proxy can look up the correct session mapping

Note: If `apiUrl` is not supported by the SDK version in use, fall back to setting `ANTHROPIC_BASE_URL` on the Anthropic client constructor level. Do NOT use `process.env` mutation as it is not concurrency-safe.

### `server/routes/settings.js`

Add two new route handlers for `GET /settings/sensitive-mask` and `POST /settings/sensitive-mask`.

---

## Error Handling

- If proxy fails to start: log error, disable feature, SDK calls go directly to Anthropic
- If mask/unmask throws: log error, pass text through unmodified (fail-open to preserve functionality)
- If custom pattern regex is invalid: skip that pattern, log warning

---

## Out of Scope (MVP)

- Frontend settings UI (toggle and pattern management) - can be added later; settings are accessible via API
- Masking in non-Claude providers (Cursor, Codex, Gemini)
- Audit log of what was masked
- Encryption at rest of the session mapping
