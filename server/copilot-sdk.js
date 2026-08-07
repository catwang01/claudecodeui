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
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createNormalizedMessage } from './providers/types.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { COPILOT_MODELS } from '../shared/modelConstants.js';
import { sessionsDb } from './database/db.js';
console.log('[copilot-sdk] Module loaded, sessionsDb type:', typeof sessionsDb, 'createSession:', typeof sessionsDb?.createSession);

// ── JSONL persistence ─────────────────────────────────────────────────────────
function getSessionJsonlPath(sessionId, cwd) {
  let projectPath = path.resolve(cwd || process.cwd());
  if (process.platform === 'win32') {
    projectPath = projectPath.toLowerCase();
  }
  const encodedPath = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encodedPath);
  fs.mkdirSync(projectDir, { recursive: true });
  return path.join(projectDir, `${sessionId}.jsonl`);
}

function appendJsonl(filePath, obj) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
  } catch (_) {}
}

function writeUserMessage(jsonlPath, sessionId, content) {
  appendJsonl(jsonlPath, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: content }] },
    sessionId,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

function writeAssistantMessage(jsonlPath, sessionId, content, model) {
  appendJsonl(jsonlPath, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      model: model || 'copilot',
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    sessionId,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

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

export function normalizeCopilotModels(models) {
  const seen = new Set();
  return models.flatMap((model) => {
    if (!model?.id || seen.has(model.id)) return [];
    seen.add(model.id);
    return [{
      value: model.id,
      label: model.name || model.id,
    }];
  });
}

export async function listCopilotModels() {
  const client = await getClient();
  return normalizeCopilotModels(await client.listModels());
}

// ── Active session tracking ───────────────────────────────────────────────────
// Map ourSessionId -> { copilotSession, abortController, startTime }
const activeSessions = new Map();

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
  const { sessionId, cwd, sessionSummary, toolsSettings } = options;
  const model = options.model || COPILOT_MODELS.DEFAULT;
  let permissionMode = options.permissionMode || 'default';

  // Mirror Claude behavior: if the user turned on "Skip permissions" (Dangerous Mode)
  // in the settings panel, promote the effective mode to bypassPermissions unless
  // the user explicitly asked for plan mode this turn.
  if (toolsSettings?.skipPermissions && permissionMode !== 'plan') {
    permissionMode = 'bypassPermissions';
  }

  let capturedSessionId = sessionId || null;
  let jsonlPath = null;
  const abortController = new AbortController();

  const send = (msg) => {
    try {
      const msgObj = typeof msg === 'string' ? JSON.parse(msg) : msg;
      console.log('[copilot-sdk] send() kind:', msgObj?.kind, 'sessionId:', msgObj?.sessionId);
      if (ws.isWebSocketWriter) {
        ws.send(msg);
      } else {
        ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
    } catch (err) {
      console.log('[copilot-sdk] send() error:', err.message);
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

    // Copilot SDK expects a PermissionResponse object (e.g. { kind: "approve-once" }),
    // NOT a boolean. Returning `true` causes "unexpected user permission response".
    const onPermissionRequest = autoApprove
      ? approveAll
      : async (_toolName, _input) => {
          // TODO: wire up interactive approval via ws permission_request events.
          // For now approve everything by default (mirror Claude's plan mode).
          return { kind: 'approve-once' };
        };

    // ── Create or resume session ──────────────────────────────────────────────
    let session;
    const existingSession = sessionId ? sessionsDb.getSessionById(sessionId) : null;
    const providerSessionId = existingSession?.provider_session_id;
    if (providerSessionId) {
      console.log(
        `[copilot-sdk] Resuming CloudCLI session ${sessionId.slice(0, 8)} via Copilot session ${providerSessionId.slice(0, 8)}`
      );
      session = await client.resumeSession(providerSessionId, { onPermissionRequest, streaming: true });
    } else {
      console.log('[copilot-sdk] Creating new session, model:', model);
      session = await client.createSession({ model, onPermissionRequest, workingDirectory: cwd, streaming: true });
    }

    // ── Map session IDs ───────────────────────────────────────────────────────
    const copilotSessionId = session.sessionId;
    if (providerSessionId && copilotSessionId !== providerSessionId) {
      throw new Error(
        `Copilot session binding mismatch: requested ${providerSessionId}, received ${copilotSessionId}`
      );
    }
    if (!capturedSessionId) {
      capturedSessionId = copilotSessionId;
    }

    // ── Init JSONL persistence ────────────────────────────────────────────────
    jsonlPath = getSessionJsonlPath(capturedSessionId, cwd);
    writeUserMessage(jsonlPath, capturedSessionId, command);

    // Register session + jsonl_path in DB so REST API can serve history
    try {
      console.log('[copilot-sdk] Registering session in DB:', capturedSessionId?.slice(0, 8), jsonlPath);
      sessionsDb.createSession(
        capturedSessionId,
        'copilot',
        cwd || process.cwd(),
        null,
        null,
        null,
        jsonlPath,
        copilotSessionId
      );
      console.log('[copilot-sdk] Session registered in DB');
    } catch (dbErr) {
      console.warn('[copilot-sdk] Failed to register session in DB:', dbErr.message);
    }

    activeSessions.set(capturedSessionId, {
      copilotSession: session,
      abortController,
      startTime: Date.now(),
    });

    // Emit session_created when this is a brand-new session
    if (!sessionId) {
      send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        sessionId: capturedSessionId,
        provider: 'copilot',
      }));
    }

    // ── Stream events ─────────────────────────────────────────────────────────
    const accumulatedTextByMessage = new Map();

    // Register streaming event listeners BEFORE send().
    session.on('assistant.message_delta', (event) => {
      const delta = event?.data?.deltaContent || '';
      if (!delta) return;
      const messageId = event?.data?.messageId || 'default';
      accumulatedTextByMessage.set(
        messageId,
        (accumulatedTextByMessage.get(messageId) || '') + delta,
      );
      send(createNormalizedMessage({
        kind: 'stream_delta',
        content: delta,
        messageId,
        sessionId: capturedSessionId,
        provider: 'copilot',
      }));
    });

    session.on('assistant.message', (event) => {
      const finalContent = event?.data?.content || '';
      const messageId = event?.data?.messageId || 'default';
      const streamed = accumulatedTextByMessage.get(messageId) || '';
      console.log(
        '[copilot-sdk] assistant.message: id=%s final=%d streamed=%d toolReqs=%d',
        messageId,
        finalContent.length,
        streamed.length,
        event?.data?.toolRequests?.length || 0,
      );

      // Persist the assistant's text for this turn to our JSONL so history
      // survives reloads. Skip empty content (tool-only turns).
      if (finalContent && jsonlPath) {
        writeAssistantMessage(jsonlPath, capturedSessionId, finalContent, model);
      }

      if (streamed) {
        // The final SDK message is authoritative. Sending it with stream_end
        // lets the frontend correct any delayed, duplicate, or missed delta
        // immediately instead of requiring a page refresh.
        send(createNormalizedMessage({
          kind: 'stream_end',
          content: finalContent || streamed,
          messageId,
          sessionId: capturedSessionId,
          provider: 'copilot',
        }));
      } else if (finalContent) {
        // No deltas arrived for this turn (non-streaming path). Send the text
        // outright so the UI still shows it.
        send(createNormalizedMessage({
          kind: 'text',
          role: 'assistant',
          content: finalContent,
          messageId,
          sessionId: capturedSessionId,
          provider: 'copilot',
        }));
      }
      // If both streamed and finalContent are empty (pure tool-call turn), the
      // frontend has nothing to finalize — leave the streaming buffer alone.

      accumulatedTextByMessage.delete(messageId);
    });

    // The SDK emits `tool.execution_start` / `tool.execution_complete` — the
    // earlier draft listened for `tool.invocation_started/finished` which never
    // fire, so tool activity silently disappeared during Copilot responses.
    session.on('tool.execution_start', (event) => {
      const t = event?.data;
      if (!t) return;
      send(createNormalizedMessage({
        kind: 'tool_use',
        toolName: t.toolName || t.mcpToolName || 'unknown',
        toolInput: t.arguments || {},
        toolId: t.toolCallId || newRequestId(),
        sessionId: capturedSessionId,
        provider: 'copilot',
      }));
    });

    session.on('tool.execution_complete', (event) => {
      const t = event?.data;
      if (!t) return;
      const rawContent = t.result?.detailedContent
        ?? t.result?.content
        ?? t.error?.message
        ?? '';
      const contentStr = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
      send(createNormalizedMessage({
        kind: 'tool_result',
        toolId: t.toolCallId || '',
        content: contentStr,
        isError: t.success === false || Boolean(t.error),
        sessionId: capturedSessionId,
        provider: 'copilot',
      }));
    });

    // Send the prompt, then wait for session.idle.
    // We register the idle listener AFTER awaiting send() so that the initial
    // idle event emitted right after createSession/resumeSession is already past
    // and we only catch the idle that signals the end of this turn.
    console.log('[copilot-sdk] Calling session.send()...');
    await session.send({ prompt: command });
    console.log('[copilot-sdk] session.send() resolved, now waiting for session.idle');

    await new Promise((resolve) => {
      const onAbort = () => {
        session.disconnect().catch(() => {});
        resolve(undefined);
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      // Log all events to understand what's happening
      const unsubAll = session.on((event) => {
        console.log('[copilot-sdk] event:', event.type, JSON.stringify(event.data)?.slice(0, 100));
      });
      session.on('session.idle', () => {
        console.log('[copilot-sdk] session.idle received — resolving');
        unsubAll();
        resolve(undefined);
      });
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
