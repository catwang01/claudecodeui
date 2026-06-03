/**
 * GitHub Copilot SDK Integration
 *
 * Integrates GitHub Copilot CLI as an agent backend via @github/copilot-sdk.
 * Architecture mirrors claude-sdk.js: queryCopilotSDK() accepts a command,
 * options, and WebSocket writer; streams events back to the frontend using
 * the same NormalizedMessage format.
 *
 * Authentication: set GITHUB_TOKEN (or COPILOT_GITHUB_TOKEN) env var,
 * or log in with the Copilot CLI beforehand.
 *
 * The Copilot CLI binary is bundled automatically by @github/copilot-sdk
 * for Node.js — no separate installation required.
 */

import { CopilotClient, approveAll } from '@github/copilot-sdk';
import crypto from 'crypto';
import { createNormalizedMessage } from './providers/types.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { COPILOT_MODELS } from '../shared/modelConstants.js';

// ── Singleton client ──────────────────────────────────────────────────────────
// One CopilotClient per process; each conversation gets its own session.
let _client = null;
let _clientStarting = false;
const _clientReadyCallbacks = [];

async function getClient() {
  if (_client) return _client;

  if (_clientStarting) {
    return new Promise((resolve, reject) => {
      _clientReadyCallbacks.push({ resolve, reject });
    });
  }

  _clientStarting = true;
  try {
    const gitHubToken = process.env.COPILOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    const client = new CopilotClient({
      ...(gitHubToken ? { gitHubToken } : {}),
    });
    await client.start();
    _client = client;
    _clientStarting = false;
    for (const cb of _clientReadyCallbacks) cb.resolve(client);
    _clientReadyCallbacks.length = 0;
    console.log('[copilot-sdk] Client started successfully');
    return client;
  } catch (err) {
    _clientStarting = false;
    for (const cb of _clientReadyCallbacks) cb.reject(err);
    _clientReadyCallbacks.length = 0;
    throw err;
  }
}

// ── Active session tracking ───────────────────────────────────────────────────
// Map ourSessionId -> { copilotSession, abortController, startTime }
const activeSessions = new Map();

// Map ourSessionId -> copilotSessionId (for resume across reconnects)
const sessionIdMap = new Map();

function newRequestId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

// ── Main query function ───────────────────────────────────────────────────────

/**
 * Execute a Copilot agent query and stream results to the WebSocket writer.
 *
 * @param {string} command - User prompt
 * @param {object} options - { sessionId, cwd, model, permissionMode, sessionSummary }
 * @param {object} ws - WebSocket writer with .send(string)
 */
export async function queryCopilotSDK(command, options = {}, ws) {
  const { sessionId, cwd, sessionSummary } = options;
  const model = options.model || COPILOT_MODELS.DEFAULT;
  const permissionMode = options.permissionMode || 'default';

  let capturedSessionId = sessionId || null;
  const abortController = new AbortController();

  const send = (msg) => {
    try {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } catch (_) {
      // WebSocket may have closed
    }
  };

  try {
    const client = await getClient();

    // ── Permission handler ────────────────────────────────────────────────────
    // For bypassPermissions / acceptEdits: approve silently.
    // Otherwise: send permission_request to UI and auto-approve for now.
    // (Full interactive approval hookup is identical to Claude and can be
    // wired up in a follow-up once the basic flow works.)
    const autoApprove = permissionMode === 'bypassPermissions' || permissionMode === 'acceptEdits';

    const onPermissionRequest = autoApprove
      ? approveAll
      : async (_toolName, _input) => {
          // TODO: wire up interactive approval via ws permission_request events
          // For now approve all — same default behavior as Claude's plan mode
          return true;
        };

    // ── Create or resume session ──────────────────────────────────────────────
    let session;
    const existingCopilotId = sessionId ? sessionIdMap.get(sessionId) : null;

    if (existingCopilotId) {
      console.log(`[copilot-sdk] Resuming session ${existingCopilotId.slice(0, 8)}`);
      try {
        session = await client.resumeSession(existingCopilotId, { onPermissionRequest });
      } catch (resumeErr) {
        console.warn('[copilot-sdk] Resume failed, creating new session:', resumeErr.message);
        session = await client.createSession({ model, onPermissionRequest, workingDirectory: cwd });
      }
    } else {
      console.log('[copilot-sdk] Creating new session, model:', model);
      session = await client.createSession({ model, onPermissionRequest, workingDirectory: cwd });
    }

    // ── Map session IDs ───────────────────────────────────────────────────────
    const copilotSessionId = session.sessionId;
    if (!capturedSessionId) {
      capturedSessionId = copilotSessionId;
    }
    sessionIdMap.set(capturedSessionId, copilotSessionId);

    activeSessions.set(capturedSessionId, {
      copilotSession: session,
      abortController,
      startTime: Date.now(),
    });

    // Emit session_created when this is a brand-new session
    if (!sessionId) {
      send(createNormalizedMessage({
        kind: 'session_created',
        sessionId: capturedSessionId,
        provider: 'copilot',
      }));
    }

    // ── Stream events ─────────────────────────────────────────────────────────
    let accumulatedText = '';

    await new Promise((resolve, reject) => {
      // Streaming deltas — send immediately for responsive UI
      session.on('assistant.message_delta', (event) => {
        const delta = event?.data?.deltaContent || '';
        if (!delta) return;
        accumulatedText += delta;
        send(createNormalizedMessage({
          kind: 'stream_delta',
          content: delta,
          sessionId: capturedSessionId,
          provider: 'copilot',
        }));
      });

      // Complete assistant message
      session.on('assistant.message', (event) => {
        const content = event?.data?.content || accumulatedText;
        if (content) {
          send(createNormalizedMessage({
            kind: 'text',
            role: 'assistant',
            content,
            sessionId: capturedSessionId,
            provider: 'copilot',
          }));
        }
        send(createNormalizedMessage({
          kind: 'stream_end',
          sessionId: capturedSessionId,
          provider: 'copilot',
        }));
        accumulatedText = '';
      });

      // Tool invocation start
      session.on('tool.invocation_started', (event) => {
        const t = event?.data;
        if (!t) return;
        send(createNormalizedMessage({
          kind: 'tool_use',
          toolName: t.name || t.toolName || 'unknown',
          toolInput: t.input || t.arguments || {},
          toolId: t.id || t.toolCallId || newRequestId(),
          sessionId: capturedSessionId,
          provider: 'copilot',
        }));
      });

      // Tool invocation result
      session.on('tool.invocation_finished', (event) => {
        const t = event?.data;
        if (!t) return;
        const content = typeof t.output === 'string'
          ? t.output
          : JSON.stringify(t.output ?? '');
        send(createNormalizedMessage({
          kind: 'tool_result',
          toolId: t.id || t.toolCallId || '',
          content,
          isError: Boolean(t.isError),
          sessionId: capturedSessionId,
          provider: 'copilot',
        }));
      });

      // Session idle = agent turn complete
      session.on('session.idle', () => resolve(undefined));

      // Abort handler
      const onAbort = () => {
        session.disconnect().catch(() => {});
        resolve(undefined);
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });

      // Fire the prompt
      session.send({ prompt: command }).catch(reject);
    });

    // ── Complete ──────────────────────────────────────────────────────────────
    const wasAborted = abortController.signal.aborted;
    send(createNormalizedMessage({
      kind: 'complete',
      exitCode: wasAborted ? 130 : 0,
      sessionId: capturedSessionId,
      provider: 'copilot',
    }));

    if (wasAborted) {
      notifyRunStopped({ writer: ws, sessionId: capturedSessionId, provider: 'copilot' });
    }

    console.log(`[copilot-sdk] Session ${capturedSessionId?.slice(0, 8)} complete (aborted=${wasAborted})`);
  } catch (err) {
    console.error('[copilot-sdk] Error:', err.message);
    send(createNormalizedMessage({
      kind: 'error',
      content: err.message,
      sessionId: capturedSessionId || sessionId,
      provider: 'copilot',
    }));
    notifyRunFailed({ writer: ws, sessionId: capturedSessionId || sessionId, provider: 'copilot' });
    send(createNormalizedMessage({
      kind: 'complete',
      exitCode: 1,
      sessionId: capturedSessionId || sessionId,
      provider: 'copilot',
    }));
  } finally {
    if (capturedSessionId) activeSessions.delete(capturedSessionId);
  }
}

// ── Session management exports ────────────────────────────────────────────────

/**
 * Abort an active Copilot session.
 * @param {string} sessionId
 * @returns {boolean} true if the session was found and aborted
 */
export function abortCopilotSession(sessionId) {
  const entry = activeSessions.get(sessionId);
  if (!entry) return false;
  entry.abortController.abort();
  return true;
}

/**
 * Check if a Copilot session is currently active.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isCopilotSessionActive(sessionId) {
  return activeSessions.has(sessionId);
}

/**
 * Get all active Copilot session IDs.
 * @returns {string[]}
 */
export function getActiveCopilotSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Get the start time of an active session.
 * @param {string} sessionId
 * @returns {number|null}
 */
export function getCopilotSessionStartTime(sessionId) {
  return activeSessions.get(sessionId)?.startTime ?? null;
}
