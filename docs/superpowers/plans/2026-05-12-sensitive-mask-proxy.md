# Sensitive Data Masking Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local HTTP proxy that intercepts all Anthropic API calls, masks sensitive patterns (API keys, credit cards, etc.) before forwarding, and unmasks responses—so the AI provider never sees real sensitive data.

**Architecture:** A lightweight HTTP server on port 3099 (`sensitive-proxy.js`) forwards Anthropic API calls with sensitive data replaced by `__MASK_TYPE_N__` placeholders. The masker module (`sensitive-masker.js`) owns all pattern logic and a per-request bi-directional mapping for consistent placeholder assignment. `queryClaudeSDK` loads user settings and passes `ANTHROPIC_BASE_URL=http://localhost:3099` in `options.env` (which the SDK uses as the subprocess env, isolating each call without touching `process.env`).

**Tech Stack:** Node.js built-in `http`/`https` modules, existing SQLite `user_settings` table, existing Express auth middleware pattern.

---

## File Map

| File | Action | Role |
|------|--------|------|
| `server/sensitive-masker.js` | Create | Pattern definitions, mask/unmask logic, global settings cache |
| `server/sensitive-proxy.js` | Create | HTTP proxy server, SSE stream unmask |
| `server/index.js` | Modify | Start proxy on server startup |
| `server/claude-sdk.js` | Modify | Load user settings, set `options.env.ANTHROPIC_BASE_URL` |
| `server/routes/settings.js` | Modify | Add `GET/POST /settings/sensitive-mask` endpoints |

---

## Task 1: Create `server/sensitive-masker.js`

**Files:**
- Create: `server/sensitive-masker.js`

- [ ] **Step 1: Create the file with pattern definitions and mask/unmask logic**

```javascript
'use strict';

const BUILTIN_PATTERNS = [
  {
    name: 'ANTHROPIC_KEY',
    regex: /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
    prefix: 'ANTHROPIC_KEY',
  },
  {
    name: 'OPENAI_KEY',
    regex: /sk-(?:proj-)?[a-zA-Z0-9]{20,}/g,
    prefix: 'OPENAI_KEY',
  },
  {
    name: 'GITHUB_TOKEN',
    regex: /(?:ghp|github_pat)_[a-zA-Z0-9_]{30,}/g,
    prefix: 'GH_TOKEN',
  },
  {
    name: 'BEARER_TOKEN',
    regex: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g,
    prefix: 'BEARER',
  },
  {
    name: 'API_KEY_PARAM',
    regex: /(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[=:]\s*["']?([a-zA-Z0-9\-_.]{16,})["']?/gi,
    prefix: 'API_KEY',
  },
  {
    name: 'CREDIT_CARD',
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    prefix: 'CREDIT_CARD',
  },
  {
    name: 'CN_ID',
    regex: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX]\b/g,
    prefix: 'ID_NUMBER',
  },
  {
    name: 'CN_PHONE',
    regex: /\b1[3-9]\d{9}\b/g,
    prefix: 'PHONE',
  },
];

// Global settings cache - updated by queryClaudeSDK before each call
let _settings = { enabled: true, disabledBuiltins: [], customPatterns: [] };

function updateSettings(settings) {
  _settings = {
    enabled: settings.enabled !== false,
    disabledBuiltins: settings.disabledBuiltins || [],
    customPatterns: settings.customPatterns || [],
  };
}

function isEnabled() {
  return _settings.enabled;
}

function getActivePatterns(settings) {
  const disabled = new Set(settings.disabledBuiltins || []);
  const builtins = BUILTIN_PATTERNS.filter(p => !disabled.has(p.name)).map(p => ({
    ...p,
    regex: new RegExp(p.regex.source, p.regex.flags),
  }));
  const customs = (settings.customPatterns || []).flatMap((re, i) => {
    try {
      return [{ name: `CUSTOM_${i}`, regex: new RegExp(re, 'g'), prefix: 'CUSTOM' }];
    } catch (e) {
      console.warn(`[sensitive-masker] invalid custom pattern "${re}": ${e.message}`);
      return [];
    }
  });
  return [...builtins, ...customs];
}

// mapping: { forward: Map<placeholder, original>, reverse: Map<original, placeholder>, counter: number }
function createMapping() {
  return { forward: new Map(), reverse: new Map(), counter: 0 };
}

function maskText(text, mapping, settings) {
  if (typeof text !== 'string' || !text) return text;
  const patterns = getActivePatterns(settings || _settings);
  let result = text;
  for (const pattern of patterns) {
    result = result.replace(pattern.regex, match => {
      if (mapping.reverse.has(match)) return mapping.reverse.get(match);
      mapping.counter += 1;
      const placeholder = `__MASK_${pattern.prefix}_${mapping.counter}__`;
      mapping.forward.set(placeholder, match);
      mapping.reverse.set(match, placeholder);
      return placeholder;
    });
  }
  return result;
}

function unmaskText(text, mapping) {
  if (typeof text !== 'string' || !text || mapping.forward.size === 0) return text;
  let result = text;
  for (const [placeholder, original] of mapping.forward) {
    result = result.split(placeholder).join(original);
  }
  return result;
}

function maskObject(obj, mapping, settings) {
  if (typeof obj === 'string') return maskText(obj, mapping, settings);
  if (Array.isArray(obj)) return obj.map(item => maskObject(item, mapping, settings));
  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = maskObject(v, mapping, settings);
    }
    return result;
  }
  return obj;
}

function unmaskObject(obj, mapping) {
  if (typeof obj === 'string') return unmaskText(obj, mapping);
  if (Array.isArray(obj)) return obj.map(item => unmaskObject(item, mapping));
  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = unmaskObject(v, mapping);
    }
    return result;
  }
  return obj;
}

module.exports = {
  BUILTIN_PATTERNS,
  updateSettings,
  isEnabled,
  createMapping,
  maskObject,
  unmaskObject,
  unmaskText,
};
```

- [ ] **Step 2: Verify the file was created with no syntax errors**

```bash
node -e "const m = require('./server/sensitive-masker'); console.log('ok', Object.keys(m))"
```

Expected output: `ok [ 'BUILTIN_PATTERNS', 'updateSettings', 'isEnabled', 'createMapping', 'maskObject', 'unmaskObject', 'unmaskText' ]`

- [ ] **Step 3: Quick manual smoke test in node REPL**

```bash
node -e "
const m = require('./server/sensitive-masker');
const mapping = m.createMapping();
const masked = m.maskObject('key is sk-ant-api03-abcdef123456789012345', mapping);
console.log('masked:', masked);
const unmasked = m.unmaskObject(masked, mapping);
console.log('unmasked:', unmasked);
console.log('roundtrip ok:', unmasked === 'key is sk-ant-api03-abcdef123456789012345');
"
```

Expected output:
```
masked: key is __MASK_ANTHROPIC_KEY_1__
unmasked: key is sk-ant-api03-abcdef123456789012345
roundtrip ok: true
```

- [ ] **Step 4: Commit**

```bash
git add server/sensitive-masker.js
git commit -m "feat(sensitive-mask): add masker module with built-in pattern definitions"
```

---

## Task 2: Create `server/sensitive-proxy.js`

**Files:**
- Create: `server/sensitive-proxy.js`

- [ ] **Step 1: Create the proxy server file**

```javascript
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const masker = require('./sensitive-masker');

const DEFAULT_PORT = 3099;

// Where to forward requests to. Read once at module load so the proxy captures
// the original value before queryClaudeSDK overrides options.env.ANTHROPIC_BASE_URL.
// If no env var is set, forward to api.anthropic.com.
const UPSTREAM_BASE = (() => {
  const raw = process.env.ANTHROPIC_BASE_URL;
  if (!raw || raw.startsWith('http://localhost:' + DEFAULT_PORT)) {
    return 'https://api.anthropic.com';
  }
  return raw.replace(/\/$/, '');
})();

let _server = null;

function startSensitiveProxy(port) {
  port = port || DEFAULT_PORT;
  _server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      handleRequest(req, res, rawBody).catch(err => {
        console.error('[sensitive-proxy] unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: 'proxy error' }));
        }
      });
    });
  });

  _server.listen(port, '127.0.0.1', () => {
    console.log(`[sensitive-proxy] listening on 127.0.0.1:${port}, upstream: ${UPSTREAM_BASE}`);
  });

  return _server;
}

function stopSensitiveProxy() {
  if (_server) {
    _server.close();
    _server = null;
  }
}

async function handleRequest(req, res, rawBody) {
  if (!masker.isEnabled()) {
    return forwardRaw(req, res, rawBody);
  }

  const mapping = masker.createMapping();

  // Mask request body
  let maskedBody = rawBody;
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json') && rawBody.length > 0) {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      const masked = masker.maskObject(parsed, mapping);
      maskedBody = Buffer.from(JSON.stringify(masked), 'utf8');
    } catch (e) {
      // Not valid JSON, forward as-is
    }
  }

  const upstreamUrl = new URL(req.url, UPSTREAM_BASE);
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;

  const forwardHeaders = { ...req.headers };
  delete forwardHeaders['host'];
  delete forwardHeaders['content-length'];
  forwardHeaders['host'] = upstreamUrl.hostname;
  forwardHeaders['content-length'] = maskedBody.length;

  const options = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || defaultPort,
    path: upstreamUrl.pathname + (upstreamUrl.search || ''),
    method: req.method,
    headers: forwardHeaders,
  };

  return new Promise((resolve, reject) => {
    const proxyReq = transport.request(options, proxyRes => {
      const isSSE = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

      if (isSSE) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        let buffer = '';
        proxyRes.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                res.write('data: [DONE]\n\n');
              } else {
                try {
                  const obj = JSON.parse(data);
                  const unmasked = masker.unmaskObject(obj, mapping);
                  res.write('data: ' + JSON.stringify(unmasked) + '\n\n');
                } catch (e) {
                  res.write(line + '\n');
                }
              }
            } else if (line !== '') {
              res.write(line + '\n');
            }
          }
        });
        proxyRes.on('end', () => {
          if (buffer) res.write(buffer);
          res.end();
          resolve();
        });
        proxyRes.on('error', reject);
      } else {
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            const obj = JSON.parse(body);
            const unmasked = masker.unmaskObject(obj, mapping);
            const unmaskedStr = JSON.stringify(unmasked);
            const responseHeaders = {
              ...proxyRes.headers,
              'content-length': Buffer.byteLength(unmaskedStr),
            };
            res.writeHead(proxyRes.statusCode, responseHeaders);
            res.end(unmaskedStr);
          } catch (e) {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end(body);
          }
          resolve();
        });
        proxyRes.on('error', reject);
      }
    });

    proxyReq.on('error', err => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      }
      resolve();
    });

    proxyReq.write(maskedBody);
    proxyReq.end();
  });
}

function forwardRaw(req, res, rawBody) {
  const upstreamUrl = new URL(req.url, UPSTREAM_BASE);
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;

  const forwardHeaders = { ...req.headers };
  delete forwardHeaders['host'];
  forwardHeaders['host'] = upstreamUrl.hostname;

  const options = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || defaultPort,
    path: upstreamUrl.pathname + (upstreamUrl.search || ''),
    method: req.method,
    headers: forwardHeaders,
  };

  return new Promise((resolve) => {
    const proxyReq = (isHttps ? https : http).request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on('end', resolve);
    });
    proxyReq.on('error', err => {
      if (!res.headersSent) { res.writeHead(502); res.end(); }
      resolve();
    });
    proxyReq.write(rawBody);
    proxyReq.end();
  });
}

module.exports = { startSensitiveProxy, stopSensitiveProxy };
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node -e "const p = require('./server/sensitive-proxy'); console.log('ok', Object.keys(p))"
```

Expected: `ok [ 'startSensitiveProxy', 'stopSensitiveProxy' ]`

- [ ] **Step 3: Commit**

```bash
git add server/sensitive-proxy.js
git commit -m "feat(sensitive-mask): add HTTP proxy server for Anthropic API interception"
```

---

## Task 3: Start proxy in `server/index.js`

**Files:**
- Modify: `server/index.js` (around line 2734, in `startServer` function)

- [ ] **Step 1: Add the import at the top of `server/index.js`**

Find the existing `require` block near the top of `server/index.js`. Add after the last `require` import of local server modules:

```javascript
const { startSensitiveProxy } = require('./sensitive-proxy');
```

- [ ] **Step 2: Start the proxy after the server starts listening**

Find the `startServer` function and the `server.listen(...)` call (around line 2756). After `server.listen(...)` completes (in the callback or just after), add:

```javascript
const SENSITIVE_PROXY_PORT = parseInt(process.env.SENSITIVE_PROXY_PORT || '3099', 10);
startSensitiveProxy(SENSITIVE_PROXY_PORT);
```

The exact location should be inside the `server.listen` callback so it starts after the main server. Look for the block that already has initialization calls (watchers, auto-doc, plugins) and add it there.

- [ ] **Step 3: Start the dev server and verify the proxy starts**

```bash
node server/index.js 2>&1 | head -20
```

Expected output includes: `[sensitive-proxy] listening on 127.0.0.1:3099, upstream: https://api.anthropic.com`

Kill the server with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat(sensitive-mask): start sensitive proxy on server startup"
```

---

## Task 4: Integrate settings loading in `server/claude-sdk.js`

**Files:**
- Modify: `server/claude-sdk.js` (around line 541, `queryClaudeSDK` function)

- [ ] **Step 1: Add import at the top of `server/claude-sdk.js`**

Find the existing `require` block. Add:

```javascript
const masker = require('./sensitive-masker');
```

- [ ] **Step 2: Load user settings and update the masker before calling query**

Find `queryClaudeSDK` (line 541). After `sdkOptions` is built by `mapCliOptionsToSDK` (around line 568) and before the `query(...)` call (around line 680), add:

```javascript
  // Load sensitive mask settings for this user and route SDK calls through local proxy
  try {
    const { userSettingsDb } = require('./database/db');
    const userId = options.userId || 'default';
    const enabledRaw = userSettingsDb.get(userId, 'sensitive_mask_enabled');
    const enabled = enabledRaw === null ? true : enabledRaw !== 'false';
    const customPatternsRaw = userSettingsDb.get(userId, 'sensitive_mask_custom_patterns');
    const disabledBuiltinsRaw = userSettingsDb.get(userId, 'sensitive_mask_disabled_builtins');
    const maskSettings = {
      enabled,
      customPatterns: customPatternsRaw ? JSON.parse(customPatternsRaw) : [],
      disabledBuiltins: disabledBuiltinsRaw ? JSON.parse(disabledBuiltinsRaw) : [],
    };
    masker.updateSettings(maskSettings);
    if (enabled) {
      const SENSITIVE_PROXY_PORT = parseInt(process.env.SENSITIVE_PROXY_PORT || '3099', 10);
      sdkOptions.env = {
        ...(sdkOptions.env || process.env),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${SENSITIVE_PROXY_PORT}`,
      };
    }
  } catch (err) {
    console.warn('[claude-sdk] could not load sensitive mask settings:', err.message);
  }
```

Note: `options.userId` may not exist yet. Check how the user ID flows into `queryClaudeSDK`. If there is no `userId` on options, look at how `writer` or the WebSocket context carries user info and adjust accordingly. If no user ID is available, use `'default'` as the fallback so the feature still works for single-user deployments.

- [ ] **Step 3: Verify the import works**

```bash
node -e "const s = require('./server/claude-sdk'); console.log('ok')"
```

Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add server/claude-sdk.js
git commit -m "feat(sensitive-mask): route SDK calls through sensitive proxy when enabled"
```

---

## Task 5: Add settings REST endpoints to `server/routes/settings.js`

**Files:**
- Modify: `server/routes/settings.js` (before the `module.exports = router` line at the end)

- [ ] **Step 1: Add the two endpoints before the export line**

Find the line `module.exports = router;` (the very last line). Insert before it:

```javascript
// Sensitive mask settings
router.get('/sensitive-mask', (req, res) => {
  try {
    const userId = req.user ? req.user.id : 'default';
    const enabledRaw = userSettingsDb.get(userId, 'sensitive_mask_enabled');
    const customPatternsRaw = userSettingsDb.get(userId, 'sensitive_mask_custom_patterns');
    const disabledBuiltinsRaw = userSettingsDb.get(userId, 'sensitive_mask_disabled_builtins');
    res.json({
      enabled: enabledRaw === null ? true : enabledRaw !== 'false',
      customPatterns: customPatternsRaw ? JSON.parse(customPatternsRaw) : [],
      disabledBuiltins: disabledBuiltinsRaw ? JSON.parse(disabledBuiltinsRaw) : [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sensitive-mask', (req, res) => {
  try {
    const userId = req.user ? req.user.id : 'default';
    const { enabled, customPatterns, disabledBuiltins } = req.body;
    if (enabled !== undefined) {
      userSettingsDb.set(userId, 'sensitive_mask_enabled', String(Boolean(enabled)));
    }
    if (Array.isArray(customPatterns)) {
      userSettingsDb.set(userId, 'sensitive_mask_custom_patterns', JSON.stringify(customPatterns));
    }
    if (Array.isArray(disabledBuiltins)) {
      userSettingsDb.set(userId, 'sensitive_mask_disabled_builtins', JSON.stringify(disabledBuiltins));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Verify the route file has no syntax errors**

```bash
node -e "const r = require('./server/routes/settings'); console.log('ok')"
```

Expected: `ok`

- [ ] **Step 3: Test the endpoints with curl (server must be running)**

Start the server in one terminal. In another:

```bash
# Get current settings
curl -s http://localhost:3001/settings/sensitive-mask | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(d))"

# Disable the feature
curl -s -X POST http://localhost:3001/settings/sensitive-mask -H "Content-Type: application/json" -d "{\"enabled\":false}" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(d))"
```

Expected GET response: `{"enabled":true,"customPatterns":[],"disabledBuiltins":[]}`
Expected POST response: `{"ok":true}`

- [ ] **Step 4: Commit**

```bash
git add server/routes/settings.js
git commit -m "feat(sensitive-mask): add GET/POST /settings/sensitive-mask endpoints"
```

---

## Task 6: End-to-end verification

**Files:**
- No changes

- [ ] **Step 1: Start the dev server and open the app in browser**

```bash
npm run dev
```

Navigate to the app (usually `http://localhost:5173` or `http://localhost:3001`).

- [ ] **Step 2: Verify the proxy is running**

Check server startup logs for: `[sensitive-proxy] listening on 127.0.0.1:3099`

- [ ] **Step 3: Test masking by sending a message containing a fake API key**

Open a chat session and send:

```
What should I do with this key: sk-ant-api03-fake1234567890abcdefghijklmno
```

While the request is in-flight (or by checking server logs), verify that `sk-ant-api03-fake1234567890abcdefghijklmno` does NOT appear in any HTTP request to `api.anthropic.com`. You can add a temporary `console.log` in `sensitive-proxy.js` `handleRequest` to print the masked body before forwarding.

- [ ] **Step 4: Verify the response comes back with the original value**

The AI's response in the chat should reference the key in unmasked form (or note it looks like an API key). The placeholder `__MASK_ANTHROPIC_KEY_1__` should NOT appear in the chat UI.

- [ ] **Step 5: Test disabling the feature via API**

```bash
curl -X POST http://localhost:3001/settings/sensitive-mask -H "Content-Type: application/json" -d "{\"enabled\":false}"
```

Send another message with the fake key. This time the proxy should pass the key through unmasked (check proxy logs).

Re-enable:

```bash
curl -X POST http://localhost:3001/settings/sensitive-mask -H "Content-Type: application/json" -d "{\"enabled\":true}"
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(sensitive-mask): complete sensitive data masking proxy implementation"
```

---

## Notes

- **userId in queryClaudeSDK:** The function signature may not include `userId`. If so, use `'default'` as the user ID for now. The settings API endpoints use `req.user.id` (from auth middleware), so authenticated requests set per-user values correctly.
- **UPSTREAM_BASE:** The proxy reads `process.env.ANTHROPIC_BASE_URL` at module load time (before `queryClaudeSDK` overrides it in `options.env`). If the user has a custom Anthropic proxy configured via that env var, the sensitive proxy will forward there instead of directly to `api.anthropic.com`.
- **Port conflict:** If port 3099 is in use, set `SENSITIVE_PROXY_PORT=3099` to a different value in the environment.
- **Non-Claude providers:** Cursor, Codex, Gemini are not covered—this is MVP scope.
