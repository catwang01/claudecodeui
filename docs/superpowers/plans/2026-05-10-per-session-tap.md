# Per-Session Claude-Tap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global claude-tap singleton with a per-session Map-based manager, add session-scoped API endpoints, a tap index page (`/tap`), and update the chat UI to enable/disable tap per session.

**Architecture:** `server/tap.js` manages a `Map<sessionId, {process, proxyPort, viewerPort, sessionTitle, startedAt}>`. New API endpoints (`/api/settings/tap/sessions/...`) control per-session tap lifecycle. The viewer wildcard proxy (`/api/tap/sessions/:sessionId/viewer`) is mounted in `index.js`. The frontend chat toggle becomes session-aware; a new `TapPage` lists all active sessions.

**Tech Stack:** Node.js/Express (backend), React + React Router (frontend), `net` module for port detection, `child_process.spawn` for claude-tap.

---

## File Map

| File | Change |
|------|--------|
| `server/tap.js` | Rewrite: singleton → Map-based manager |
| `server/routes/settings.js` | Remove old tap endpoints; add session-scoped CRUD |
| `server/index.js` | Remove startup tap auto-start; update imports/shutdown; mount per-session viewer proxy |
| `server/claude-sdk.js` | Update import + inject per-session tap URL |
| `src/components/chat/view/ChatInterface.tsx` | Thread `sessionId`/`sessionTitle` into ChatComposer |
| `src/components/chat/view/subcomponents/ChatComposer.tsx` | Thread props to ChatInputControls |
| `src/components/chat/view/subcomponents/ChatInputControls.tsx` | Per-session tap toggle + link to /tap |
| `src/pages/TapPage.tsx` | New: tap session index page |
| `src/App.tsx` | Add `/tap` route |
| `src/components/settings/view/tabs/DebugSettingsTab.tsx` | Remove global toggle; add link to /tap |

---

## Task 1: Rewrite `server/tap.js` as Map-based manager

**Files:**
- Modify: `server/tap.js` (full rewrite, 331 lines → ~220 lines)

- [ ] **Step 1: Write the new `server/tap.js`**

Replace the entire file with:

```js
/**
 * Claude-tap Integration — Per-Session Manager
 *
 * Each session can have its own claude-tap proxy + viewer process pair.
 * tapSessions maps sessionId → { process, proxyPort, viewerPort, sessionTitle, startedAt }
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import http from 'http';
import path from 'path';
import os from 'os';
import net from 'net';

const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com';
const DEFAULT_TAP_PORT = 18080;
const DEFAULT_TAP_LIVE_PORT = 18081;

// Map<sessionId, { process, proxyPort, viewerPort, sessionTitle, startedAt }>
const tapSessions = new Map();

// ---------------------------------------------------------------------------
// Upstream URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the effective Anthropic base URL using the same priority order
 * as the Claude SDK:
 *  1. ANTHROPIC_BASE_URL process env var
 *  2. ~/.claude/settings.json → env.ANTHROPIC_BASE_URL
 *  3. https://api.anthropic.com (default)
 */
export async function resolveAnthropicBaseUrl() {
  if (process.env.ANTHROPIC_BASE_URL) {
    return process.env.ANTHROPIC_BASE_URL;
  }
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const content = await fs.readFile(settingsPath, 'utf8');
    const settings = JSON.parse(content);
    if (settings?.env?.ANTHROPIC_BASE_URL) {
      return settings.env.ANTHROPIC_BASE_URL;
    }
  } catch {
    // missing / malformed — fall through
  }
  return DEFAULT_ANTHROPIC_URL;
}

// ---------------------------------------------------------------------------
// Port helpers
// ---------------------------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(preferred) {
  if (await isPortFree(preferred)) return preferred;
  for (let p = preferred + 1; p < preferred + 100; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`[tap] No free port found near ${preferred}`);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Starts a claude-tap proxy+viewer process pair for a specific session.
 * No-op if a tap process already exists for this sessionId.
 *
 * @param {string} sessionId
 * @param {string} [sessionTitle]
 * @param {string} [anthropicBaseUrl]
 * @returns {Promise<{proxyPort, viewerPort, sessionTitle, startedAt}>}
 */
export async function startTapForSession(sessionId, sessionTitle, anthropicBaseUrl) {
  if (tapSessions.has(sessionId)) {
    const s = tapSessions.get(sessionId);
    return { proxyPort: s.proxyPort, viewerPort: s.viewerPort, sessionTitle: s.sessionTitle, startedAt: s.startedAt };
  }

  const targetUrl = anthropicBaseUrl || DEFAULT_ANTHROPIC_URL;
  const proxyPort = await findFreePort(DEFAULT_TAP_PORT);
  const viewerPort = await findFreePort(proxyPort + 1);

  return new Promise((resolve, reject) => {
    const args = [
      '--tap-no-launch',
      '--tap-port', String(proxyPort),
      '--tap-target', targetUrl,
      '--tap-live',
      '--tap-live-port', String(viewerPort),
    ];

    console.log(`[tap] Starting session ${sessionId}: proxy=${proxyPort}, viewer=${viewerPort}, target=${targetUrl}`);

    const proc = spawn('claude-tap', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: [
          process.env.PATH,
          '/usr/local/bin',
          '/opt/homebrew/bin',
          `${os.homedir()}/.local/bin`,
        ].filter(Boolean).join(':'),
      },
    });

    proc.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[tap:${sessionId.slice(0, 8)}] ${line}`);
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.error(`[tap:${sessionId.slice(0, 8)}] ${line}`);
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('[tap] claude-tap not found in PATH. Install with: pip install claude-tap');
      } else {
        console.error('[tap] Failed to start proxy:', err.message);
      }
      tapSessions.delete(sessionId);
      reject(err);
    });

    proc.on('exit', (code, signal) => {
      console.log(`[tap:${sessionId.slice(0, 8)}] Proxy exited (code=${code}, signal=${signal})`);
      tapSessions.delete(sessionId);
    });

    const startedAt = new Date().toISOString();
    tapSessions.set(sessionId, { process: proc, proxyPort, viewerPort, sessionTitle: sessionTitle || sessionId.slice(0, 8), startedAt });

    let resolved = false;
    const readyTimer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ proxyPort, viewerPort, sessionTitle, startedAt }); }
    }, 1500);

    proc.stdout.on('data', (data) => {
      if (!resolved && data.toString().includes('listening')) {
        resolved = true;
        clearTimeout(readyTimer);
        resolve({ proxyPort, viewerPort, sessionTitle, startedAt });
      }
    });
  });
}

/**
 * Stops the claude-tap process for a specific session.
 */
export function stopTapForSession(sessionId) {
  const session = tapSessions.get(sessionId);
  if (session) {
    console.log(`[tap] Stopping session ${sessionId}`);
    session.process.kill('SIGTERM');
    tapSessions.delete(sessionId);
  }
}

/**
 * Returns the tap session data for a sessionId, or null if not running.
 */
export function getTapSession(sessionId) {
  return tapSessions.get(sessionId) ?? null;
}

/**
 * Returns metadata for all active tap sessions.
 */
export function listTapSessions() {
  return Array.from(tapSessions.entries()).map(([sessionId, s]) => ({
    sessionId,
    sessionTitle: s.sessionTitle,
    proxyPort: s.proxyPort,
    viewerPort: s.viewerPort,
    startedAt: s.startedAt,
  }));
}

/**
 * Stops all running tap session processes. Called on server shutdown.
 */
export function stopAllTapSessions() {
  for (const [sessionId, session] of tapSessions) {
    console.log(`[tap] Stopping session ${sessionId} on shutdown`);
    session.process.kill('SIGTERM');
  }
  tapSessions.clear();
}

// ---------------------------------------------------------------------------
// Viewer proxy (per-session)
// ---------------------------------------------------------------------------

/**
 * Express middleware that proxies requests to the claude-tap live viewer
 * for a specific session. Handles HTTP responses and SSE streams.
 *
 * Mount in index.js:
 *   app.use('/api/tap/sessions/:sessionId/viewer', authenticateToken,
 *     (req, res) => tapViewerProxyForSession(req.params.sessionId, req, res));
 */
export function tapViewerProxyForSession(sessionId, req, res) {
  const session = tapSessions.get(sessionId);
  if (!session) {
    res.status(503).json({ error: 'No tap session running for this session' });
    return;
  }

  const { viewerPort } = session;
  const targetPath = req.url || '/';
  const forwardPath = targetPath.replace(/[?&]token=[^&]*/g, '').replace(/[?&]$/, '') || '/';
  const token = req.query.token ?? '';
  const isHtmlRoot = forwardPath === '/' || forwardPath === '';

  const options = {
    hostname: '127.0.0.1',
    port: viewerPort,
    path: forwardPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${viewerPort}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] ?? '';

    if (isHtmlRoot && contentType.includes('text/html')) {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        // Rewrite EventSource('/events') to go through our auth proxy
        const eventsUrl = token
          ? `/api/tap/sessions/${sessionId}/viewer/events?token=${encodeURIComponent(token)}`
          : `/api/tap/sessions/${sessionId}/viewer/events`;
        html = html.replace(
          /new EventSource\(['"]\/events['"]\)/g,
          `new EventSource('${eventsUrl}')`
        );
        const headers = { ...proxyRes.headers, 'content-length': Buffer.byteLength(html) };
        res.writeHead(proxyRes.statusCode, headers);
        res.end(html);
      });
    } else {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `Tap viewer unreachable: ${err.message}` });
    }
  });

  req.pipe(proxyReq, { end: true });
}
```

- [ ] **Step 2: Verify the file was saved correctly**

```bash
node --input-type=module < server/tap.js 2>&1 | head -5
```

Expected: no output (module parses cleanly) or only expected startup messages.

- [ ] **Step 3: Commit**

```bash
git add server/tap.js
git commit -m "refactor(tap): rewrite as per-session Map-based manager"
```

---

## Task 2: Update `server/routes/settings.js`

**Files:**
- Modify: `server/routes/settings.js`

- [ ] **Step 1: Update imports at the top of the file**

Find the line (around line 5):
```js
import { startTapProxy, stopTapProxy, getTapProxyPort, getTapLivePort, resolveAnthropicBaseUrl, tapViewerProxy } from '../tap.js';
```

Replace with:
```js
import { startTapForSession, stopTapForSession, getTapSession, listTapSessions, resolveAnthropicBaseUrl } from '../tap.js';
```

- [ ] **Step 2: Replace old tap endpoints with session-scoped endpoints**

Find the tap section (lines 351–397):
```js
// ===============================
// Claude-tap (API traffic inspector)
// ===============================

router.get('/tap', async (req, res) => {
  ...
});

router.put('/tap', async (req, res) => {
  ...
});
```

Replace the entire section with:
```js
// ===============================
// Claude-tap (API traffic inspector) — per-session
// ===============================

router.get('/tap/sessions', (req, res) => {
  res.json(listTapSessions());
});

router.get('/tap/sessions/:sessionId', (req, res) => {
  const session = getTapSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'No tap session for this sessionId' });
  res.json({
    sessionId: req.params.sessionId,
    sessionTitle: session.sessionTitle,
    proxyPort: session.proxyPort,
    viewerPort: session.viewerPort,
    startedAt: session.startedAt,
  });
});

router.post('/tap/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { sessionTitle } = req.body;
  try {
    const targetUrl = await resolveAnthropicBaseUrl();
    const result = await startTapForSession(sessionId, sessionTitle || sessionId.slice(0, 8), targetUrl);
    res.json({ sessionId, ...result });
  } catch (err) {
    const message = err.code === 'ENOENT'
      ? 'claude-tap not found. Install with: pip install claude-tap (requires Python 3.11+)'
      : `Failed to start tap proxy: ${err.message}`;
    res.status(500).json({ error: message });
  }
});

router.delete('/tap/sessions/:sessionId', (req, res) => {
  stopTapForSession(req.params.sessionId);
  res.json({ success: true });
});
```

- [ ] **Step 3: Verify no remaining references to old tap functions**

```bash
grep -n "getTapProxyPort\|getTapLivePort\|startTapProxy\|stopTapProxy\|tapViewerProxy" server/routes/settings.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add server/routes/settings.js
git commit -m "refactor(tap): replace global tap endpoints with session-scoped CRUD"
```

---

## Task 3: Update `server/index.js`

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Update the import at line 77**

Find:
```js
import { startTapProxy, stopTapProxy, resolveAnthropicBaseUrl, tapViewerProxy } from './tap.js';
```

Replace with:
```js
import { stopAllTapSessions, tapViewerProxyForSession } from './tap.js';
```

- [ ] **Step 2: Replace the old viewer proxy mount at line 518**

Find:
```js
// claude-tap live viewer proxy (protected) — proxies to 127.0.0.1:<livePort>
app.use('/api/tap/viewer', authenticateToken, tapViewerProxy);
```

Replace with:
```js
// claude-tap per-session viewer proxy (protected) — proxies to each session's viewer port
app.use('/api/tap/sessions/:sessionId/viewer', authenticateToken, (req, res) => {
  tapViewerProxyForSession(req.params.sessionId, req, res);
});
```

- [ ] **Step 3: Remove the startup tap auto-start block (lines 2698–2705)**

Find:
```js
            // Start claude-tap proxy if enabled in config
            const tapEnabled = appConfigDb.get('tap_enabled');
            if (tapEnabled === 'true') {
                const targetUrl = await resolveAnthropicBaseUrl();
                startTapProxy(targetUrl).catch(err => {
                    console.warn('[tap] Could not start proxy:', err.message);
                });
            }
```

Delete this block entirely (5 lines).

- [ ] **Step 4: Update the shutdown handler (line 2715)**

Find:
```js
        const shutdownPlugins = async () => {
            stopTapProxy();
            await stopAllPlugins();
            process.exit(0);
        };
```

Replace with:
```js
        const shutdownPlugins = async () => {
            stopAllTapSessions();
            await stopAllPlugins();
            process.exit(0);
        };
```

- [ ] **Step 5: Verify no remaining references to old tap functions**

```bash
grep -n "startTapProxy\|stopTapProxy\|tapViewerProxy\b\|getTapProxyPort\|getTapLivePort\|tap_enabled" server/index.js
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add server/index.js
git commit -m "refactor(tap): update index.js for per-session tap proxy"
```

---

## Task 4: Update `server/claude-sdk.js`

**Files:**
- Modify: `server/claude-sdk.js`

- [ ] **Step 1: Update the import at line 16**

Find:
```js
import { getTapProxyPort } from './tap.js';
```

Replace with:
```js
import { getTapSession } from './tap.js';
```

- [ ] **Step 2: Update `mapCliOptionsToSDK` (lines 237–248)**

Find:
```js
  // If claude-tap proxy is running, override ANTHROPIC_BASE_URL via extraArgs.settings.
  // --settings JSON is the highest-priority settings layer, overriding user settings.json
  // (which may have a custom ANTHROPIC_BASE_URL like a company proxy endpoint).
  const tapPort = getTapProxyPort();
  if (tapPort) {
    const tapUrl = `http://127.0.0.1:${tapPort}`;
    sdkOptions.extraArgs = {
      settings: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: tapUrl }
      })
    };
    console.log(`[tap] extraArgs.settings ANTHROPIC_BASE_URL=${tapUrl}`);
  } else {
    console.log('[tap] proxy not running, no URL override');
  }
```

Replace with:
```js
  // If a per-session claude-tap proxy is running, override ANTHROPIC_BASE_URL via extraArgs.settings.
  const tapSession = sessionId ? getTapSession(sessionId) : null;
  if (tapSession) {
    const tapUrl = `http://127.0.0.1:${tapSession.proxyPort}`;
    sdkOptions.extraArgs = {
      settings: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: tapUrl }
      })
    };
    console.log(`[tap] session ${sessionId.slice(0, 8)}: ANTHROPIC_BASE_URL=${tapUrl}`);
  }
```

- [ ] **Step 3: Verify `sessionId` is in scope at that point**

In `mapCliOptionsToSDK`, line 149: `const { sessionId, cwd, toolsSettings, permissionMode } = options;` — `sessionId` is already destructured. No change needed.

- [ ] **Step 4: Commit**

```bash
git add server/claude-sdk.js
git commit -m "refactor(tap): inject per-session tap URL in mapCliOptionsToSDK"
```

---

## Task 5: Thread `sessionId` from `ChatInterface` → `ChatComposer` → `ChatInputControls`

**Files:**
- Modify: `src/components/chat/view/ChatInterface.tsx`
- Modify: `src/components/chat/view/subcomponents/ChatComposer.tsx`

- [ ] **Step 1: Add `sessionId` and `sessionTitle` to `ChatComposerProps`**

In `src/components/chat/view/subcomponents/ChatComposer.tsx`, find the `ChatComposerProps` interface (line 37) and add at the end before the closing `}`:

```ts
  sessionId: string | null;
  sessionTitle: string | null;
```

- [ ] **Step 2: Destructure in `ChatComposer` function**

In `ChatComposer` function signature (line 103), add after `onVoiceToggle,`:
```ts
  sessionId,
  sessionTitle,
```

- [ ] **Step 3: Pass props to `ChatInputControls` in `ChatComposer`**

Find the `<ChatInputControls` render (line 203). Add after `onVoiceToggle={onVoiceToggle}`:
```tsx
          sessionId={sessionId}
          sessionTitle={sessionTitle}
```

- [ ] **Step 4: Pass `sessionId`/`sessionTitle` from `ChatInterface` to `ChatComposer`**

In `src/components/chat/view/ChatInterface.tsx`, find the `<ChatComposer` block (line 440). Add after `onAbortSession={handleAbortSession}`:
```tsx
          sessionId={selectedSession?.id ?? null}
          sessionTitle={selectedSession?.title ?? selectedSession?.summary ?? null}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/view/ChatInterface.tsx src/components/chat/view/subcomponents/ChatComposer.tsx
git commit -m "feat(tap): thread sessionId through ChatInterface → ChatComposer"
```

---

## Task 6: Update `ChatInputControls` for per-session tap toggle

**Files:**
- Modify: `src/components/chat/view/subcomponents/ChatInputControls.tsx`

- [ ] **Step 1: Add `sessionId` and `sessionTitle` to `ChatInputControlsProps`**

Find the `ChatInputControlsProps` interface (line 10). Add at the end before `}`:
```ts
  sessionId: string | null;
  sessionTitle: string | null;
```

- [ ] **Step 2: Destructure in the function**

Find the function destructuring (line 30). Add after `onVoiceToggle,`:
```ts
  sessionId,
  sessionTitle,
```

- [ ] **Step 3: Replace tap state and handlers (lines 51–78)**

Find:
```ts
  const [tapEnabled, setTapEnabled] = useState(false);
  const [tapToggling, setTapToggling] = useState(false);

  useEffect(() => {
    authenticatedFetch('/api/settings/tap')
      .then(res => res.json())
      .then(data => setTapEnabled(!!data.enabled))
      .catch(() => {});
  }, []);

  const handleTapToggle = async () => {
    setTapToggling(true);
    try {
      const res = await authenticatedFetch('/api/settings/tap', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !tapEnabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setTapEnabled(!!data.enabled);
      }
    } catch {
      // ignore
    } finally {
      setTapToggling(false);
    }
  };
```

Replace with:
```ts
  const [tapEnabled, setTapEnabled] = useState(false);
  const [tapToggling, setTapToggling] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    authenticatedFetch(`/api/settings/tap/sessions/${sessionId}`)
      .then(res => { if (res.ok) setTapEnabled(true); })
      .catch(() => {});
  }, [sessionId]);

  const handleTapToggle = async () => {
    if (!sessionId) return;
    setTapToggling(true);
    try {
      if (tapEnabled) {
        await authenticatedFetch(`/api/settings/tap/sessions/${sessionId}`, { method: 'DELETE' });
        setTapEnabled(false);
      } else {
        const res = await authenticatedFetch(`/api/settings/tap/sessions/${sessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionTitle: sessionTitle || sessionId.slice(0, 8) }),
        });
        if (res.ok) setTapEnabled(true);
      }
    } catch {
      // ignore
    } finally {
      setTapToggling(false);
    }
  };
```

- [ ] **Step 4: Replace the tap viewer link (lines 249–261)**

Find:
```tsx
      {tapEnabled && (
        <a
          href={`/api/tap/viewer?token=${encodeURIComponent(localStorage.getItem('auth-token') ?? '')}`}
          target="_blank"
          rel="noreferrer"
          title="Open API trace viewer"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-orange-500 transition-colors hover:bg-orange-500/15 sm:h-8 sm:w-8"
        >
          <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      )}
```

Replace with:
```tsx
      {tapEnabled && (
        <a
          href="/tap"
          target="_blank"
          rel="noreferrer"
          title="Open tap sessions"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-orange-500 transition-colors hover:bg-orange-500/15 sm:h-8 sm:w-8"
        >
          <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      )}
```

- [ ] **Step 5: Build check**

```bash
cd /Users/tanhuan/claudecodeui && npm run build 2>&1 | grep -E "error TS|Error:"
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/view/subcomponents/ChatInputControls.tsx
git commit -m "feat(tap): per-session tap toggle in ChatInputControls"
```

---

## Task 7: Create `src/pages/TapPage.tsx`

**Files:**
- Create: `src/pages/TapPage.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useEffect, useState } from 'react';
import { Radio, ExternalLink, Square } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';

interface TapSession {
  sessionId: string;
  sessionTitle: string;
  proxyPort: number;
  viewerPort: number;
  startedAt: string;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr} hr ago`;
}

export default function TapPage() {
  const [sessions, setSessions] = useState<TapSession[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSessions = () => {
    authenticatedFetch('/api/settings/tap/sessions')
      .then(res => res.json())
      .then((data: TapSession[]) => setSessions(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleStop = async (sessionId: string) => {
    await authenticatedFetch(`/api/settings/tap/sessions/${sessionId}`, { method: 'DELETE' });
    setSessions(prev => prev.filter(s => s.sessionId !== sessionId));
  };

  const viewerUrl = (sessionId: string) => {
    const token = localStorage.getItem('auth-token') ?? '';
    return `/api/tap/sessions/${sessionId}/viewer?token=${encodeURIComponent(token)}`;
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center gap-3">
          <Radio className="h-5 w-5 text-orange-500" />
          <h1 className="text-xl font-semibold text-foreground">Tap Sessions</h1>
          {sessions.length > 0 && (
            <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-500">
              {sessions.length} running
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">No active tap sessions.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Enable tap for a session using the <Radio className="inline h-3 w-3" /> button in the chat input.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Session</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Started</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sessions.map(s => (
                  <tr key={s.sessionId} className="bg-card hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground">
                      {s.sessionTitle}
                      <span className="ml-2 text-xs text-muted-foreground">:{s.proxyPort}</span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatRelativeTime(s.startedAt)}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                        Running
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={viewerUrl(s.sessionId)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                        >
                          <ExternalLink className="h-3 w-3" />
                          View
                        </a>
                        <button
                          type="button"
                          onClick={() => handleStop(s.sessionId)}
                          className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors"
                        >
                          <Square className="h-3 w-3" />
                          Stop
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build check**

```bash
cd /Users/tanhuan/claudecodeui && npm run build 2>&1 | grep -E "error TS|Error:"
```

Expected: one error about `TapPage` not imported in App.tsx — Task 8 fixes it.

- [ ] **Step 3: Commit**

```bash
git add src/pages/TapPage.tsx
git commit -m "feat(tap): add TapPage session index"
```

---

## Task 8: Add `/tap` route in `src/App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add import**

After line 11 (`import AppContent from './components/app/AppContent';`), add:
```tsx
import TapPage from './pages/TapPage';
```

- [ ] **Step 2: Add route**

Find:
```tsx
                          <Routes>
                            <Route path="/" element={<AppContent />} />
                            <Route path="/session/:sessionId" element={<AppContent />} />
                          </Routes>
```

Replace with:
```tsx
                          <Routes>
                            <Route path="/" element={<AppContent />} />
                            <Route path="/session/:sessionId" element={<AppContent />} />
                            <Route path="/tap" element={<TapPage />} />
                          </Routes>
```

- [ ] **Step 3: Build check**

```bash
cd /Users/tanhuan/claudecodeui && npm run build 2>&1 | grep -E "error TS|Error:"
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(tap): add /tap route for session index page"
```

---

## Task 9: Update `DebugSettingsTab.tsx` — remove global toggle, add link to /tap

**Files:**
- Modify: `src/components/settings/view/tabs/DebugSettingsTab.tsx`

- [ ] **Step 1: Replace the entire file**

```tsx
import { Radio, Bug, ExternalLink } from 'lucide-react';

export default function DebugSettingsTab() {
  return (
    <div className="space-y-6 md:space-y-8">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bug className="w-5 h-5 text-orange-500" />
          <h3 className="text-lg font-medium text-foreground">Debug Tools</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Developer tools for inspecting internal behavior.
        </p>
      </div>

      {/* Claude-tap section */}
      <div className="space-y-4 bg-card border border-border rounded-lg p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm font-medium text-foreground">API Traffic Inspector</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Intercept and record Claude API traffic via{' '}
              <a
                href="https://github.com/liaohch3/claude-tap"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground transition-colors"
              >
                claude-tap
              </a>
              . Enable per-session using the <Radio className="inline h-3 w-3" /> button in the chat input.
              Requires <code className="text-xs bg-muted px-1 rounded">pip install claude-tap</code>.
            </p>
          </div>
          <a
            href="/tap"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors flex-shrink-0"
          >
            <ExternalLink className="h-3 w-3" />
            Sessions
          </a>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build check**

```bash
cd /Users/tanhuan/claudecodeui && npm run build 2>&1 | grep -E "error TS|Error:"
```

Expected: no TypeScript errors, clean build.

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/view/tabs/DebugSettingsTab.tsx
git commit -m "feat(tap): update DebugSettingsTab — per-session, link to /tap"
```

---

## Task 10: Integration smoke test

- [ ] **Step 1: Start dev server**

```bash
cd /Users/tanhuan/claudecodeui && npm run dev
```

- [ ] **Step 2: Verify backend endpoints exist**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/api/settings/tap/sessions \
  -H "Authorization: Bearer $(cat ~/.claudecodeui.token 2>/dev/null || echo test)"
```

Expected: `200` (returns `[]` empty array).

- [ ] **Step 3: Manual test — enable tap for a session**

1. Open a chat session in the browser
2. Click the `Radio` button in the chat input bar → button turns orange, indicator dot appears
3. Click the external-link icon → opens `/tap` in a new tab
4. `/tap` page shows one row with the session name, "Running" status, "View" and "Stop" buttons
5. Click "View" → opens the claude-tap live viewer in a new tab
6. Send a message in the chat → traffic appears in the tap viewer
7. Click "Stop" in the `/tap` page → row disappears, session button returns to off

- [ ] **Step 4: Final commit**

```bash
git add docs/superpowers/plans/2026-05-10-per-session-tap.md
git commit -m "feat(tap): per-session claude-tap proxy and viewer index"
```
