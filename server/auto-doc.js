/**
 * Auto-Doc Background Timer
 *
 * Periodically resumes the most recent Claude sessions (via forkSession) and
 * sends a prompt to perform file-system work (e.g. organising docs).
 * No output is captured; results live entirely in the file system.
 * session_summary_state is used only to avoid re-running a session that has
 * received fewer than NEW_MSG_THRESHOLD new messages since the last run.
 */

import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import readline from 'readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { sessionDb, appConfigDb } from './database/db.js';
import { forkSession } from './projects.js';
import { getActiveClaudeSDKSessions } from './claude-sdk.js';

const DEFAULT_INTERVAL_MS = parseInt(process.env.AUTO_DOC_INTERVAL_MS, 10) || 30 * 60 * 1000;
const DEFAULT_PROMPT = process.env.AUTO_DOC_PROMPT ||
  'Based on this conversation, please organize and update the relevant project documentation.';

const DEFAULT_MODEL = process.env.AUTO_DOC_MODEL || 'claude-opus-4-6';

// Re-run only when the session has grown by at least this many messages
const NEW_MSG_THRESHOLD = 20;

// Skip sessions with fewer than this many total messages (not worth processing)
const DEFAULT_MIN_SESSION_MSG_COUNT = 20;

// How many most-recent sessions to consider each batch
const MAX_SESSIONS = 20;

// Skip sessions whose file was modified within this window (likely still active)
const ACTIVE_FILE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function getConfig() {
  const intervalMs = parseInt(appConfigDb.get('auto_doc_interval_ms'), 10) || DEFAULT_INTERVAL_MS;
  const prompt = appConfigDb.get('auto_doc_prompt') || DEFAULT_PROMPT;
  const minMessageCount = parseInt(appConfigDb.get('auto_doc_min_message_count'), 10) || DEFAULT_MIN_SESSION_MSG_COUNT;
  const model = appConfigDb.get('auto_doc_model') || DEFAULT_MODEL;
  return { intervalMs, prompt, minMessageCount, model };
}

// ─── JSONL parser ─────────────────────────────────────────────────────────────

/**
 * Parse a single JSONL file and return session metadata needed for scheduling.
 * Returns [{ id, messageCount, cwd, lastUserMessage, lastActivity }]
 */
async function parseSessionsMeta(filePath) {
  const sessions = new Map();

  const fileStream = fsSync.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const sid = entry.sessionId;
    if (!sid) continue;

    if (!sessions.has(sid)) {
      sessions.set(sid, {
        id: sid,
        messageCount: 0,
        cwd: entry.cwd || '',
        lastUserMessage: '',
        lastActivity: null,
      });
    }

    const s = sessions.get(sid);

    if (entry.cwd && !s.cwd) s.cwd = entry.cwd;

    if (entry.timestamp) {
      const t = new Date(entry.timestamp);
      if (!s.lastActivity || t > s.lastActivity) s.lastActivity = t;
    }

    const role = entry.message?.role;
    if (role === 'user' || role === 'assistant') {
      s.messageCount++;
      if (role === 'user') {
        const c = entry.message.content;
        const text = Array.isArray(c)
          ? (c.find(p => p.type === 'text')?.text || '')
          : (typeof c === 'string' ? c : '');
        if (text) s.lastUserMessage = text;
      }
    }
  }

  return Array.from(sessions.values());
}

// ─── Session collection ───────────────────────────────────────────────────────

async function collectRecentSessions() {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const all = [];

  let entries;
  try {
    entries = await fs.readdir(claudeDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dirEntry of entries.filter(e => e.isDirectory())) {
    const projectPath = path.join(claudeDir, dirEntry.name);
    let files;
    try { files = await fs.readdir(projectPath); } catch { continue; }

    for (const file of files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))) {
      try {
        const filePath = path.join(projectPath, file);
        const stat = await fs.stat(filePath);
        const parsed = await parseSessionsMeta(filePath);
        for (const s of parsed) {
          s.projectName = dirEntry.name;
          s.fileMtime = stat.mtime;
        }
        all.push(...parsed);
      } catch { /* skip malformed */ }
    }
  }

  // Sort by most recent activity, return top MAX_SESSIONS
  return all
    .filter(s => s.lastActivity)
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, MAX_SESSIONS);
}

// ─── Candidate selection ──────────────────────────────────────────────────────

async function selectCandidates(sessions, config) {
  if (!sessions.length) return [];

  const ids = sessions.map(s => s.id);
  const stateMap = sessionDb.getDocStateMap(ids, 'claude');
  const autoDocSessionIds = sessionDb.getAutoDocSessionIds(ids, 'claude');
  const { minMessageCount } = config;

  const activeSessionIds = new Set(getActiveClaudeSDKSessions());
  const now = Date.now();
  // Tie the active-file threshold to the configured interval so short intervals
  // don't over-block recently-idle sessions. Cap at 10 minutes.
  const activeFileThresholdMs = Math.min(config.intervalMs / 3, ACTIVE_FILE_THRESHOLD_MS);

  return sessions.filter(session => {
    // Skip sessions that are currently being processed via the UI
    if (activeSessionIds.has(session.id)) return false;
    // Skip sessions that are themselves auto-doc forks
    if (autoDocSessionIds.has(session.id)) return false;
    if (session.messageCount < minMessageCount) return false;
    // Skip sessions whose file was modified recently — likely still active (CLI session)
    if (session.fileMtime && (now - session.fileMtime.getTime()) < activeFileThresholdMs) return false;

    const state = stateMap.get(session.id);
    if (state) {
      const newMessages = session.messageCount - state.last_message_count;
      if (newMessages < NEW_MSG_THRESHOLD) return false;
    }

    return true;
  });
}

// ─── Per-session runner ───────────────────────────────────────────────────────

async function runSession(session, config) {
  const { prompt, model } = config;
  const start = Date.now();

  // Save state BEFORE forking so that if the server restarts mid-run, the session
  // won't be picked up again on next startup (prevents duplicate forks).
  sessionDb.setDocState(
    session.id,
    'claude',
    session.messageCount,
    session.lastUserMessage,
    0 // durationMs unknown yet; will be updated after completion
  );

  // Use server-side fork so the new session has its own JSONL with full history.
  // SDK forkSession leaves parent history under the original sessionId, making it
  // invisible to the frontend's sessionId-filtered message reader.
  const forkedSessionId = await forkSession(session.projectName, session.id);

  // Mark the fork immediately so the frontend can identify it as an auto-doc session
  sessionDb.markAsAutoDocSession(forkedSessionId, session.id, 'claude');

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const sdkOptions = {
    resume: forkedSessionId,
    model,
    cwd: session.cwd || process.cwd(),
    maxTurns: 20,
    permissionMode: 'bypassPermissions',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user', 'local'],
    tools: { type: 'preset', preset: 'claude_code' },
    env,
  };

  // Drain the generator
  for await (const _ of query({ prompt, options: sdkOptions })) { /* no-op */ }

  const durationMs = Date.now() - start;

  // Update with actual duration now that we're done
  sessionDb.setDocState(
    session.id,
    'claude',
    session.messageCount,
    session.lastUserMessage,
    durationMs
  );

  console.log(`[AutoDoc] ${session.id} done (${durationMs}ms)`);
}

// ─── Batch ────────────────────────────────────────────────────────────────────

let batchRunning = false;

async function runBatch() {
  if (batchRunning) {
    console.log('[AutoDoc] Batch already running, skipping');
    return;
  }
  batchRunning = true;
  try {
    const config = getConfig();
    const sessions = await collectRecentSessions();
    const candidates = await selectCandidates(sessions, config);

    if (!candidates.length) return;

    console.log(`[AutoDoc] ${candidates.length} session(s) to process`);

    for (const session of candidates) {
      try {
        await runSession(session, config);
      } catch (err) {
        console.warn(`[AutoDoc] Failed for ${session.id}: ${err.message}`);
      }
    }
  } finally {
    batchRunning = false;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

let timerStarted = false;

export function startAutoDocTimer() {
  if (timerStarted) {
    console.log('[AutoDoc] Timer already started, skipping duplicate call');
    return;
  }
  timerStarted = true;

  const fire = () =>
    runBatch().catch(err => console.warn('[AutoDoc] Batch error:', err.message));

  // Recursive setTimeout so that interval changes in settings take effect on the next cycle
  function scheduleNext() {
    const { intervalMs } = getConfig();
    setTimeout(async () => { await fire(); scheduleNext(); }, intervalMs);
  }

  fire(); // Run immediately on startup
  scheduleNext();

  const { intervalMs } = getConfig();
  console.log(`[AutoDoc] Timer started (interval: ${intervalMs / 1000}s)`);
}
