/**
 * Claude-tap Integration
 *
 * Manages a claude-tap reverse proxy process that intercepts API traffic
 * between the Claude SDK and the Anthropic API (or any custom upstream).
 *
 * When active, every SDK session's ANTHROPIC_BASE_URL is overridden to
 * point at the local claude-tap proxy, while the proxy forwards upstream
 * to whatever URL was previously configured (env var / settings.json / default).
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

let tapProcess = null;
let tapPort = null;
let tapLivePort = null;

// ---------------------------------------------------------------------------
// Upstream URL resolution
// ---------------------------------------------------------------------------

// Set of project cwd paths we've written tap settings to — for cleanup on stop.
const patchedProjectDirs = new Set();

/**
 * Writes ANTHROPIC_BASE_URL into <projectDir>/.claude/settings.json so the
 * claude CLI picks it up (project-level settings override user-level ones).
 * Tracks which dirs were patched for cleanup when tap is stopped.
 */
export async function patchProjectSettings(cwd) {
  if (!tapPort || !cwd) return;
  const settingsDir = path.join(cwd, '.claude');
  const settingsFile = path.join(settingsDir, 'settings.json');
  try {
    await fs.mkdir(settingsDir, { recursive: true });
    let settings = {};
    try {
      settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    } catch { /* new file */ }
    settings.env = settings.env ?? {};
    if (settings.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${tapPort}`) return; // already set
    settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${tapPort}`;
    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    patchedProjectDirs.add(cwd);
    console.log(`[tap] Patched ${settingsFile}`);
  } catch (err) {
    console.warn(`[tap] Could not patch project settings (${cwd}):`, err.message);
  }
}

/**
 * Removes the tap ANTHROPIC_BASE_URL from every project settings.json we wrote.
 */
async function restoreProjectSettings() {
  for (const cwd of patchedProjectDirs) {
    const settingsFile = path.join(cwd, '.claude', 'settings.json');
    try {
      const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
      if (settings?.env?.ANTHROPIC_BASE_URL?.startsWith('http://127.0.0.1:')) {
        delete settings.env.ANTHROPIC_BASE_URL;
        if (Object.keys(settings.env).length === 0) delete settings.env;
        await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
        console.log(`[tap] Restored ${settingsFile}`);
      }
    } catch { /* ignore missing / malformed */ }
  }
  patchedProjectDirs.clear();
}

/**
 * Resolves the effective Anthropic base URL using the same priority order
 * as the Claude SDK:
 *  1. ANTHROPIC_BASE_URL process env var
 *  2. ~/.claude/settings.json  →  env.ANTHROPIC_BASE_URL
 *  3. https://api.anthropic.com (default)
 */
export async function resolveAnthropicBaseUrl() {
  // Priority 1: process environment
  if (process.env.ANTHROPIC_BASE_URL) {
    return process.env.ANTHROPIC_BASE_URL;
  }

  // Priority 2: ~/.claude/settings.json
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
// Proxy lifecycle
// ---------------------------------------------------------------------------

/**
 * Starts the claude-tap proxy in proxy-only mode (--tap-no-launch).
 *
 * @param {string} targetUrl - Upstream API URL (ANTHROPIC_BASE_URL or default)
 * @param {number} [preferredPort] - Preferred local port (default 18080)
 * @returns {Promise<{port: number, livePort: number}>} - The proxy port and live viewer port
 */
export async function startTapProxy(targetUrl, preferredPort = DEFAULT_TAP_PORT) {
  if (tapProcess) {
    console.log(`[tap] Proxy already running on port ${tapPort}`);
    return { port: tapPort, livePort: tapLivePort };
  }

  const port = await findFreePort(preferredPort);
  const livePort = await findFreePort(DEFAULT_TAP_LIVE_PORT);

  return new Promise((resolve, reject) => {
    const args = [
      '--tap-no-launch',
      '--tap-port', String(port),
      '--tap-target', targetUrl,
      '--tap-live',
      '--tap-live-port', String(livePort),
    ];

    console.log(`[tap] Starting claude-tap proxy → ${targetUrl} on port ${port}, live viewer on port ${livePort}`);

    const proc = spawn('claude-tap', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Augment PATH with common Python tool install locations in case the
      // server process was started without a full user shell environment.
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
      if (line) console.log(`[tap] ${line}`);
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.error(`[tap] ${line}`);
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('[tap] claude-tap not found in PATH. Install with: pip install claude-tap');
      } else {
        console.error('[tap] Failed to start proxy:', err.message);
      }
      tapProcess = null;
      tapPort = null;
      reject(err);
    });

    proc.on('exit', (code, signal) => {
      console.log(`[tap] Proxy exited (code=${code}, signal=${signal})`);
      tapProcess = null;
      tapPort = null;
      tapLivePort = null;
    });

    tapProcess = proc;
    tapPort = port;
    tapLivePort = livePort;

    // Give the proxy up to 1.5 s to bind. We also watch stdout for the
    // "listening" line so startup is fast under normal conditions.
    let resolved = false;

    const readyTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ port, livePort });
      }
    }, 1500);

    proc.stdout.on('data', (data) => {
      if (!resolved && data.toString().includes('listening')) {
        resolved = true;
        clearTimeout(readyTimer);
        resolve({ port, livePort });
      }
    });
  });
}

/**
 * Stops the running claude-tap proxy process.
 */
export function stopTapProxy() {
  if (tapProcess) {
    console.log('[tap] Stopping proxy...');
    tapProcess.kill('SIGTERM');
    tapProcess = null;
    tapPort = null;
    tapLivePort = null;
  }
  restoreProjectSettings().catch(err =>
    console.warn('[tap] Error restoring project settings:', err.message)
  );
}

/**
 * Returns the port of the currently running proxy, or null if not running.
 */
export function getTapProxyPort() {
  return tapPort;
}

/**
 * Returns the live viewer port, or null if not running.
 */
export function getTapLivePort() {
  return tapLivePort;
}

/**
 * Express middleware that proxies all requests to the claude-tap live viewer.
 * Handles both regular HTTP responses and SSE streams.
 *
 * On the root HTML page, rewrites the hardcoded EventSource('/events') URL
 * to go through this proxy so auth tokens are preserved for SSE requests.
 *
 * Mount at a prefix, e.g.:  app.use('/api/tap/viewer', tapViewerProxy)
 * The prefix is stripped before forwarding.
 */
export function tapViewerProxy(req, res) {
  const port = tapLivePort;
  if (!port) {
    res.status(503).json({ error: 'claude-tap live viewer is not running' });
    return;
  }

  const targetPath = req.url || '/';

  // Strip the ?token= query param before forwarding — claude-tap doesn't need it
  const forwardPath = targetPath.replace(/[?&]token=[^&]*/g, '').replace(/[?&]$/, '') || '/';

  // Keep the token so we can re-embed it into the HTML for the SSE sub-request
  const token = req.query.token ?? '';

  const isHtmlRoot = forwardPath === '/' || forwardPath === '';

  const options = {
    hostname: '127.0.0.1',
    port,
    path: forwardPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${port}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] ?? '';

    if (isHtmlRoot && contentType.includes('text/html')) {
      // Collect body so we can rewrite the EventSource URL
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        // Rewrite:  new EventSource('/events')
        //       →   new EventSource('/api/tap/viewer/events?token=<tok>')
        const eventsUrl = token
          ? `/api/tap/viewer/events?token=${encodeURIComponent(token)}`
          : '/api/tap/viewer/events';
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
