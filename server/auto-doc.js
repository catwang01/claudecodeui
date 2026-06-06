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
import { query } from '@anthropic-ai/claude-agent-sdk';
import { sessionDb, appConfigDb, sessionFileCache } from './database/db.js';
import { forkSession } from './projects.js';
import { getActiveClaudeSDKSessions } from './claude-sdk.js';

const DEFAULT_INTERVAL_MS = parseInt(process.env.AUTO_DOC_INTERVAL_MS, 10) || 30 * 60 * 1000;
const DEFAULT_PROMPT = process.env.AUTO_DOC_PROMPT ||
  'Based on this conversation, please organize and update the relevant project documentation.';

const DEFAULT_MODEL = process.env.AUTO_DOC_MODEL || 'claude-opus-4.7';

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

// ─── Candidate selection ──────────────────────────────────────────────────────

async function collectRecentSessions() {
  // Use session_file_cache DB instead of opening all JSONL files.
  // This avoids opening ~10k fds at startup (the old collectRecentSessions() opened
  // every single JSONL file via parseSessionsMeta, exhausting the fd table and causing
  // posix_spawn EBADF when new sessions tried to spawn child processes).
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

  let rows;
  try {
    // Fetch top MAX_SESSIONS * 5 candidates (generous buffer so filtering by
    // minMessageCount + autoDoc exclusion still leaves enough).
    rows = sessionFileCache.getRecentClaude(MAX_SESSIONS * 5);
  } catch (err) {
    console.warn('[AutoDoc] Failed to query session_file_cache:', err.message);
    return [];
  }

  const sessions = [];
  for (const row of rows) {
    // Extract projectName from the JSONL file path:
    // ~/.claude/projects/{projectName}/{sessionId}.jsonl
    const rel = path.relative(claudeProjectsDir, row.file_path);
    const parts = rel.split(path.sep);
    if (parts.length < 2) continue; // unexpected path shape, skip

    const projectName = parts[0];

    sessions.push({
      id: row.session_id,
      messageCount: row.message_count || 0,
      cwd: row.cwd || '',
      lastUserMessage: row.last_user_message || '',
      lastActivity: new Date(row.last_activity),
      projectName,
      // fileMtime is populated lazily below — we only stat the final candidate set,
      // not all ~10k files.
      fileMtime: null,
      _filePath: row.file_path,
    });
  }

  // Sort by most recent activity first, take top MAX_SESSIONS candidates
  const candidates = sessions
    .filter(s => s.lastActivity && !isNaN(s.lastActivity))
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, MAX_SESSIONS);

  // Stat only the small candidate set to populate fileMtime for the active-session check.
  await Promise.all(candidates.map(async (s) => {
    try {
      const stat = await fs.stat(s._filePath);
      s.fileMtime = stat.mtime;
    } catch {
      // File gone — selectCandidates will still skip it via minMessageCount etc.
    }
  }));

  return candidates;
}

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
