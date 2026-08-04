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
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(true));
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
      const current = tapSessions.get(sessionId);
      if (current?.process === proc) tapSessions.delete(sessionId);
    });

    const normalizedTitle = sessionTitle || sessionId.slice(0, 8);
    const startedAt = new Date().toISOString();
    tapSessions.set(sessionId, { process: proc, proxyPort, viewerPort, sessionTitle: normalizedTitle, startedAt });

    let resolved = false;
    const readyTimer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ proxyPort, viewerPort, sessionTitle: normalizedTitle, startedAt }); }
    }, 1500);

    proc.stdout.on('data', (data) => {
      if (!resolved && data.toString().includes('listening')) {
        resolved = true;
        clearTimeout(readyTimer);
        resolve({ proxyPort, viewerPort, sessionTitle: normalizedTitle, startedAt });
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
