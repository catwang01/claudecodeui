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

import { CopilotClient, approveAll, defineTool } from '@github/copilot-sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createNormalizedMessage } from './providers/types.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { COPILOT_MODELS } from '../shared/modelConstants.js';
import { sessionDb, sessionsDb } from './database/db.js';
import { getProjects } from './projects.js';
import {
  waitForCopilotSessionSummary,
} from './modules/providers/list/copilot/copilot-session-synchronizer.provider.js';
import {
  assertRegularFile,
  assertSafeLocalArtifactPath,
  createArtifactUrl,
  getSafeImageMimeType,
} from './utils/artifact-metadata.js';
console.log('[copilot-sdk] Module loaded, sessionsDb type:', typeof sessionsDb, 'createSession:', typeof sessionsDb?.createSession);

export async function refreshCopilotSessionSummary(nativeSessionId, send) {
  const sessionId = await waitForCopilotSessionSummary(nativeSessionId);
  if (!sessionId) {
    return false;
  }

  send({
    type: 'projects_updated',
    projects: await getProjects(),
    timestamp: new Date().toISOString(),
    changeType: 'change',
    watchProvider: 'copilot',
    updatedSessionIds: [sessionId],
    batched: false,
  });
  return true;
}

export function getCopilotEventsPath(sessionId) {
  return path.join(os.homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
}

export function resolveCopilotSessionId(sessionId) {
  return sessionsDb.getSessionById(sessionId)?.provider_session_id || sessionId;
}

export function normalizeLegacyCopilotEvents(content) {
  const lines = String(content).split('\n');
  const cancelledScheduleIds = new Set();

  for (const line of lines) {
    if (!line.includes('"type":"session.schedule_cancelled"')) continue;
    try {
      const event = JSON.parse(line);
      if (Number.isInteger(event.data?.id)) cancelledScheduleIds.add(event.data.id);
    } catch {
      // Leave malformed lines unchanged so the native resume error remains actionable.
    }
  }

  let changed = false;
  const normalizedLines = lines.map((line) => {
    if (line.includes('"type":"skill.invoked"')) {
      try {
        const event = JSON.parse(line);
        const data = event.data;
        if (
          typeof data?.name === 'string'
          && typeof data.path === 'string'
          && typeof data.content === 'string'
        ) {
          const normalizedData = {
            name: data.name,
            path: data.path,
            content: data.content,
            ...(Array.isArray(data.allowedTools) ? { allowedTools: data.allowedTools } : {}),
            ...(typeof data.source === 'string' ? { source: data.source } : {}),
            ...(typeof data.pluginName === 'string' ? { pluginName: data.pluginName } : {}),
            ...(typeof data.pluginVersion === 'string' ? { pluginVersion: data.pluginVersion } : {}),
            ...(typeof data.description === 'string' ? { description: data.description } : {}),
            ...(
              ['user-invoked', 'agent-invoked', 'context-load'].includes(data.trigger)
                ? { trigger: data.trigger }
                : {}
            ),
          };
          if (JSON.stringify(normalizedData) !== JSON.stringify(data)) {
            event.data = normalizedData;
            changed = true;
            return JSON.stringify(event);
          }
        }
      } catch {
        return line;
      }
    }

    if (!line.includes('"type":"session.schedule_created"')) return line;
    try {
      const event = JSON.parse(line);
      const data = event.data;
      if (
        data?.selfPaced !== true
        || data.intervalMs != null
        || !Number.isInteger(data.id)
        || !cancelledScheduleIds.has(data.id)
        || typeof data.prompt !== 'string'
      ) {
        return line;
      }

      event.data = {
        id: data.id,
        intervalMs: 1,
        prompt: data.prompt,
        ...(typeof data.recurring === 'boolean' ? { recurring: data.recurring } : {}),
        ...(typeof data.displayPrompt === 'string' ? { displayPrompt: data.displayPrompt } : {}),
      };
      changed = true;
      return JSON.stringify(event);
    } catch {
      return line;
    }
  });

  return {
    content: changed ? normalizedLines.join('\n') : content,
    changed,
  };
}

export function migrateLegacyCopilotEventsFile(eventsPath) {
  if (!fs.existsSync(eventsPath)) return false;

  const original = fs.readFileSync(eventsPath, 'utf8');
  const normalized = normalizeLegacyCopilotEvents(original);
  if (!normalized.changed) return false;

  const backupPath = `${eventsPath}.cloudcli-backup`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(eventsPath, backupPath, fs.constants.COPYFILE_EXCL);
  }

  const tempPath = `${eventsPath}.cloudcli-migrating`;
  fs.writeFileSync(tempPath, normalized.content, 'utf8');
  fs.renameSync(tempPath, eventsPath);
  return true;
}

function extractMessageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function buildCopilotForkPrompt(jsonlContent, command, maxHistoryChars = 100_000) {
  const messages = [];
  for (const line of String(jsonlContent || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const role = entry.message?.role
        ?? (entry.type === 'user.message' ? 'user' : null)
        ?? (entry.type === 'assistant.message' ? 'assistant' : null);
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractMessageText(entry.message?.content ?? entry.data?.content);
      if (text) messages.push({ role, text });
    } catch {
      // Ignore malformed transcript lines.
    }
  }

  if (messages.length === 0) return command;

  const selected = [];
  let remaining = maxHistoryChars;
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i];
    const label = message.role === 'user' ? 'User' : 'Assistant';
    const availableText = message.text.length > remaining
      ? message.text.slice(message.text.length - remaining)
      : message.text;
    selected.unshift(`${label}:\n${availableText}`);
    remaining -= availableText.length;
  }

  return [
    'This conversation was forked from an earlier point. Use the prior conversation below as context, then respond to the current user request. Do not describe or repeat the imported context unless asked.',
    '',
    '<prior_conversation>',
    selected.join('\n\n'),
    '</prior_conversation>',
    '',
    '<current_user_request>',
    command,
    '</current_user_request>',
  ].join('\n');
}

export function buildCopilotAttachments({ images = [], files = [], references = [] } = {}) {
  const attachments = [];
  const attachedPaths = new Set();

  for (const image of images) {
    const match = typeof image?.data === 'string'
      ? image.data.match(/^data:([^;]+);base64,(.+)$/)
      : null;
    if (!match) continue;
    attachments.push({
      type: 'blob',
      data: match[2],
      mimeType: image.mimeType || match[1],
      displayName: image.name || 'image',
    });
  }

  const fileCandidates = [
    ...files.map((file) => ({
      path: file?.path,
      displayName: file?.name,
    })),
    ...references.map((reference) => ({
      path: reference,
      displayName: path.basename(reference || ''),
    })),
  ];

  for (const candidate of fileCandidates) {
    if (!candidate.path || attachedPaths.has(candidate.path)) continue;
    try {
      if (!fs.statSync(candidate.path).isFile()) continue;
    } catch {
      continue;
    }
    attachedPaths.add(candidate.path);
    attachments.push({
      type: 'file',
      path: candidate.path,
      displayName: candidate.displayName || path.basename(candidate.path),
    });
  }

  return attachments;
}

const FILEPATH_SCHEMA = {
  type: 'object',
  properties: {
    filepath: {
      type: 'string',
      description: 'Absolute path to the existing file',
    },
  },
  required: ['filepath'],
  additionalProperties: false,
};

function resolveArtifactPath(filepath, workingDirectory) {
  return path.isAbsolute(filepath)
    ? filepath
    : path.resolve(workingDirectory || process.cwd(), filepath);
}

export function createCopilotInternalTools(workingDirectory) {
  return [
    defineTool('download', {
      description: 'Make an existing file available for the user to download. Use this for generated files, including HTML artifacts. The file must already exist on disk.',
      parameters: FILEPATH_SCHEMA,
      skipPermission: true,
      handler: async ({ filepath }) => {
        const absolutePath = resolveArtifactPath(filepath, workingDirectory);
        assertSafeLocalArtifactPath(absolutePath);
        await fs.promises.access(absolutePath);
        const stats = await fs.promises.stat(absolutePath);
        assertRegularFile(stats, absolutePath);
        const filename = path.basename(absolutePath);
        return JSON.stringify({
          artifactKind: 'download',
          filepath: absolutePath,
          filename,
          downloadUrl: createArtifactUrl('download', absolutePath),
          fileSize: stats.size,
          message: `File "${filename}" is ready. The UI will display a download button.`,
        });
      },
    }),
    defineTool('image', {
      description: 'Display an existing image inline in the chat UI. Use this when showing a generated or existing image would be helpful. The file must already exist on disk.',
      parameters: FILEPATH_SCHEMA,
      skipPermission: true,
      handler: async ({ filepath }) => {
        const absolutePath = resolveArtifactPath(filepath, workingDirectory);
        assertSafeLocalArtifactPath(absolutePath);
        await fs.promises.access(absolutePath);
        const stats = await fs.promises.stat(absolutePath);
        assertRegularFile(stats, absolutePath);
        const filename = path.basename(absolutePath);
        const mimeType = getSafeImageMimeType(absolutePath);
        if (!mimeType) {
          throw new Error(`Unsupported image format: ${path.extname(filename) || '(none)'}`);
        }
        return JSON.stringify({
          artifactKind: 'image',
          filepath: absolutePath,
          filename,
          imageUrl: createArtifactUrl('image', absolutePath),
          fileSize: stats.size,
          mimeType,
          message: `Image "${filename}" is ready. The UI will display it inline.`,
        });
      },
    }),
  ];
}

export function buildCopilotSessionConfig(config) {
  return {
    ...config,
    tools: [
      ...(config.tools || []),
      ...createCopilotInternalTools(config.workingDirectory),
    ],
  };
}

export function buildCopilotArtifactMessage(toolResult, pendingTools, sessionId) {
  const toolName = pendingTools.get(toolResult.toolCallId);
  if (toolName !== 'download' && toolName !== 'image') return null;

  const resultData = typeof toolResult.content === 'string'
    ? JSON.parse(toolResult.content)
    : toolResult.content;

  if (toolName === 'download' && resultData?.artifactKind === 'download') {
    return createNormalizedMessage({
      kind: 'file_download',
      sessionId,
      provider: 'copilot',
      filename: resultData.filename,
      filepath: resultData.filepath,
      downloadUrl: resultData.downloadUrl,
      fileSize: resultData.fileSize,
    });
  }

  if (toolName === 'image' && resultData?.artifactKind === 'image') {
    return createNormalizedMessage({
      kind: 'image_display',
      sessionId,
      provider: 'copilot',
      filename: resultData.filename,
      filepath: resultData.filepath,
      imageUrl: resultData.imageUrl,
      fileSize: resultData.fileSize,
      mimeType: resultData.mimeType,
    });
  }

  throw new Error(`Invalid ${toolName} tool result`);
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
    const isUnboundFork = Boolean(
      sessionId
      && !providerSessionId
      && sessionDb.getForkParentMap([sessionId], 'copilot').has(sessionId)
    );
    let promptToSend = command;
    if (isUnboundFork && existingSession?.jsonl_path) {
      try {
        const forkHistory = fs.readFileSync(existingSession.jsonl_path, 'utf8');
        promptToSend = buildCopilotForkPrompt(forkHistory, command);
        console.log(`[copilot-sdk] Bootstrapping fork ${sessionId.slice(0, 8)} from managed transcript`);
      } catch (err) {
        throw new Error(`Unable to load Copilot fork history: ${err.message}`);
      }
    }
    if (providerSessionId) {
      console.log(
        `[copilot-sdk] Resuming CloudCLI session ${sessionId.slice(0, 8)} via Copilot session ${providerSessionId.slice(0, 8)}`
      );
      const eventsPath = getCopilotEventsPath(providerSessionId);
      if (migrateLegacyCopilotEventsFile(eventsPath)) {
        console.log(`[copilot-sdk] Migrated cancelled legacy schedule metadata in ${eventsPath}`);
      }
      session = await client.resumeSession(providerSessionId, buildCopilotSessionConfig({
        onPermissionRequest,
        workingDirectory: cwd,
        streaming: true,
        enableConfigDiscovery: true,
      }));
    } else {
      console.log('[copilot-sdk] Creating new session, model:', model);
      session = await client.createSession(buildCopilotSessionConfig({
        model,
        onPermissionRequest,
        workingDirectory: cwd,
        streaming: true,
        enableConfigDiscovery: true,
      }));
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

    // Copilot owns the transcript. Keep only a reference to its native event log.
    jsonlPath = getCopilotEventsPath(copilotSessionId);

    // Register the native Copilot transcript so REST API can serve history.
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
    const pendingInternalTools = new Map();

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
      if (t.toolName === 'download' || t.toolName === 'image') {
        pendingInternalTools.set(t.toolCallId, t.toolName);
      }
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

      if (pendingInternalTools.has(t.toolCallId)) {
        try {
          const artifactMessage = buildCopilotArtifactMessage({
            toolCallId: t.toolCallId,
            content: contentStr,
          }, pendingInternalTools, capturedSessionId);
          if (artifactMessage) {
            send(artifactMessage);
          }
        } catch (error) {
          console.error(`[copilot-sdk] Failed to emit ${pendingInternalTools.get(t.toolCallId)} artifact:`, error);
        } finally {
          pendingInternalTools.delete(t.toolCallId);
        }
      }
    });

    // Send the prompt, then wait for session.idle.
    // We register the idle listener AFTER awaiting send() so that the initial
    // idle event emitted right after createSession/resumeSession is already past
    // and we only catch the idle that signals the end of this turn.
    console.log('[copilot-sdk] Calling session.send()...');
    const attachments = buildCopilotAttachments(options);
    await session.send({
      prompt: promptToSend,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
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
    } else {
      void refreshCopilotSessionSummary(copilotSessionId, send).catch((error) => {
        console.error('[copilot-sdk] Failed to refresh delayed session summary:', error);
      });
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
