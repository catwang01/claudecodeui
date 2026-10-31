#!/usr/bin/env node
/**
 * End-to-end acceptance check for the AutoDoc retirement (docs/scheduled-tasks.md
 * section 11, issue #4 follow-up). Lead-owned verification script.
 *
 * Boots the real server (tsx) against a throwaway SQLite database and a throwaway
 * SCHEDULED_TASK_DATA_DIR with SCHEDULED_TASK_DRY_RUN=1, then asserts section 11.5:
 *   1. GET /api/settings/auto-doc -> 404 (GET and PUT); GET /api/settings/automations
 *      returns only hideScheduledTaskSessions; POST ignores legacy auto-doc keys (200).
 *   2. No [auto-doc] log output; auto_doc_sessions neither grows nor is dropped
 *      while the server runs (and the table + rows survive a restart).
 *   3. /api/projects sessions carry no isAutoDoc / lastAutoDocAt, and a session id
 *      that IS present in auto_doc_sessions comes back as an ordinary session.
 *   4. The auto-doc builtin preset seeds, lists (template auto-doc-docs-refresh) and
 *      installs with enabled=true by default; its script gate returns a skip
 *      envelope on a project without new conversations, the run is recorded
 *      'skipped' and no model call happens under SCHEDULED_TASK_DRY_RUN=1.
 *   5. Historical auto_doc_sessions rows are kept (they survive a server restart).
 *
 * Guards the real ~/.claudecodeui/scheduled-tasks (the script always points
 * SCHEDULED_TASK_DATA_DIR at its throwaway temp dir) and cleans up the unique
 * temporary ~/.claude/projects entry it creates for the session check.
 *
 * Usage: node scripts/verify-autodoc-retirement.mjs
 * Exit code 0 = all checks passed; 1 = at least one failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// better-sqlite3 ships a native binding compiled for Node 22 (see .nvmrc).
function resolveNodeBinDir() {
  if (process.env.E2E_NODE_BIN) return process.env.E2E_NODE_BIN;
  const nvmBin = path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.17.0', 'bin');
  if (fs.existsSync(path.join(nvmBin, 'node'))) return nvmBin;
  return null;
}

const NODE_BIN_DIR = resolveNodeBinDir();
if (NODE_BIN_DIR) console.log('[autodoc-e2e] using node bin dir: ' + NODE_BIN_DIR + ' (current: ' + process.version + ')');
else if (process.version !== 'v22.17.0') console.warn('[autodoc-e2e] WARNING: no Node 22 bin dir found; better-sqlite3 may fail under ' + process.version);

const PORT = Number(process.env.E2E_PORT || 3489);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-retire-e2e-'));
const DB_PATH = path.join(TMP, 'auth.db');
const DATA_DIR = path.join(TMP, 'scheduled-task-data');
const PROJECT_DOC = path.join(TMP, 'project-doc');
const PROJECT_EMPTY = path.join(TMP, 'project-empty');
const PROJECT_ENC = PROJECT_DOC.replace(/[^a-zA-Z0-9]/g, '-');
const EMPTY_ENC = PROJECT_EMPTY.replace(/[^a-zA-Z0-9]/g, '-');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_DIR = path.join(CLAUDE_PROJECTS, PROJECT_ENC);
const EMPTY_CLAUDE_DIR = path.join(CLAUDE_PROJECTS, EMPTY_ENC);
const HOME_DATA_DIR = path.join(os.homedir(), '.claudecodeui', 'scheduled-tasks');
const SID = 'verify-autodoc-ordinary-session';
const SRC_SID = 'verify-autodoc-source-session';
const USER = { username: 'autodocuser', password: 'autodoc-password' };
const LF = String.fromCharCode(10);

let child = null;
let token = null;
let db = null;
let passed = 0;
const failures = [];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function check(name, fn) {
  try {
    const out = await fn();
    passed += 1;
    console.log('  PASS  ' + name + (out === undefined ? '' : '  -> ' + out));
  } catch (err) {
    failures.push(name + ': ' + err.message);
    console.log('  FAIL  ' + name + '  -> ' + err.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries only thrown network errors (never a completed response), so a stale
// keep-alive socket right after the server restart cannot fail the run.
async function doFetch(url, options, attempts = 4) {
  let lastDetail = 'unknown';
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastDetail = err && err.cause
        ? (err.cause.code || err.cause.message || String(err.cause))
        : (err && err.message ? err.message : String(err));
      await sleep(250 * (i + 1));
    }
  }
  throw new Error('fetch failed after ' + attempts + ' attempts for ' + url + ': ' + lastDetail);
}

function snapshotDir(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

function readTextFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { return ''; }
}

function startServer() {
  const env = {
    ...process.env,
    ...(NODE_BIN_DIR ? { PATH: NODE_BIN_DIR + path.delimiter + process.env.PATH } : {}),
    SERVER_PORT: String(PORT),
    VITE_PORT: '5197',
    DATABASE_PATH: DB_PATH,
    SCHEDULED_TASK_DATA_DIR: DATA_DIR,
    SCHEDULED_TASKS_ENABLED: '1',
    SCHEDULED_TASKS_TICK_MS: '1000',
    SCHEDULED_TASK_DRY_RUN: '1',
    NODE_ENV: 'production',
  };
  const proc = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.js'], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const logPath = path.join(TMP, 'server.log');
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  proc.stdout.pipe(stream);
  proc.stderr.pipe(stream);
  proc.on('exit', (code) => stream.write(LF + '[server exited ' + code + ']' + LF));
  return { proc, logPath };
}

// The server is spawned detached, so the whole process group must be killed:
// npx exits immediately while its tsx/node child keeps listening, which made the
// next boot fail with EADDRINUSE while health was still answered by the dying
// old server. Reap the group with SIGKILL unconditionally and wait until the
// port really refuses connections.
function killGroup(proc, signal) {
  try { process.kill(-proc.pid, signal); } catch { /* group already gone */ }
  try { proc.kill(signal); } catch { /* process already gone */ }
}

async function portClosed() {
  try {
    await fetch(BASE + '/health', { signal: AbortSignal.timeout(700) });
    return false;
  } catch (err) {
    const code = err && err.cause ? err.cause.code : null;
    return code === 'ECONNREFUSED' || code === 'ECONNRESET';
  }
}

async function waitPortFree(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portClosed()) return true;
    await sleep(250);
  }
  return false;
}

async function stopServer() {
  if (!child) return;
  const proc = child.proc;
  child = null;
  killGroup(proc, 'SIGTERM');
  let free = await waitPortFree(6000);
  killGroup(proc, 'SIGKILL');
  if (!free) free = await waitPortFree(8000);
  if (!free) console.warn('[autodoc-e2e] WARNING: port ' + PORT + ' still answered after SIGKILL');
}

function tailLog(lines = 25) {
  if (!child) return '(no server)';
  try {
    return fs.readFileSync(child.logPath, 'utf8').split(LF).slice(-lines).join(LF);
  } catch {
    return '(unreadable log)';
  }
}

async function waitForHealth(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no attempt';
  while (Date.now() < deadline) {
    if (child && child.proc.exitCode !== null) {
      throw new Error('server exited early (code ' + child.proc.exitCode + '); log: ' + tailLog());
    }
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return;
      lastErr = 'status ' + res.status;
    } catch (err) {
      lastErr = err.message;
    }
    await sleep(400);
  }
  throw new Error('server not healthy after ' + timeoutMs + 'ms (' + lastErr + '); log: ' + tailLog());
}

async function api(method, url, body, expect) {
  const res = await doFetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(method + ' ' + url + ' expected HTTP ' + expect + ' got ' + res.status + ' body=' + text.slice(0, 300));
  }
  return { status: res.status, json, text };
}

// Raw request that does NOT follow redirects, so a removed API route is reported
// by its real status (the SPA catch-all can 302/200 instead of 404).
async function apiRaw(method, url, body) {
  const res = await doFetch(BASE + url, {
    method,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text: text };
}

async function poll(label, fn, { timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error('timed out waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
}

async function openDb() {
  const mod = await import('better-sqlite3');
  const Database = mod.default;
  db = new Database(DB_PATH, { timeout: 5000 });
  db.pragma('busy_timeout = 5000');
  return db;
}

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function autoDocCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM auto_doc_sessions').get().n;
}

function insertAutoDocRow(forkedId, sourceId, createdAt) {
  db.prepare(
    'INSERT OR IGNORE INTO auto_doc_sessions (forked_session_id, source_session_id, provider, created_at) VALUES (?, ?, ?, ?)'
  ).run(forkedId, sourceId, 'claude', createdAt);
}

function hasAutoDocRow(forkedId) {
  return !!db.prepare('SELECT forked_session_id FROM auto_doc_sessions WHERE forked_session_id = ?').get(forkedId);
}

// ── Fixtures: a project with one transcript + a project with no transcripts ───
fs.mkdirSync(PROJECT_DOC, { recursive: true });
fs.mkdirSync(PROJECT_EMPTY, { recursive: true });
assert(!fs.existsSync(CLAUDE_DIR), 'refusing to reuse an existing Claude project dir: ' + CLAUDE_DIR);
assert(!fs.existsSync(EMPTY_CLAUDE_DIR), 'refusing to reuse an existing Claude project dir: ' + EMPTY_CLAUDE_DIR);

function sessionLine(sessionId, cwd, text, timestamp) {
  return JSON.stringify({
    sessionId: sessionId,
    cwd: cwd,
    type: 'user',
    timestamp: timestamp,
    uuid: 'verify-uuid-' + sessionId,
    parentUuid: null,
    message: { role: 'user', content: text },
  });
}

// Written only once the server is up: if the directory existed at boot, the
// boot-time session synchronizer would pre-register the project itself.
function writeTranscriptFixture() {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(CLAUDE_DIR, SID + '.jsonl'), sessionLine(SID, PROJECT_DOC, 'ordinary session', nowIso) + LF, 'utf8');
  fs.writeFileSync(path.join(CLAUDE_DIR, SRC_SID + '.jsonl'), sessionLine(SRC_SID, PROJECT_DOC, 'source session', nowIso) + LF, 'utf8');
}

async function main() {
  console.log('[autodoc-e2e] temp dir: ' + TMP);
  console.log('[autodoc-e2e] data dir: ' + DATA_DIR);
  assert(DATA_DIR.startsWith(TMP), 'data dir must live under the temp dir');
  assert(CLAUDE_DIR.startsWith(CLAUDE_PROJECTS), 'fixture dir must live under ~/.claude/projects');
  const homeBefore = snapshotDir(HOME_DATA_DIR);
  const expectedAutoDocRows = { value: 0 };

  child = startServer();
  await waitForHealth();

  await check('bootstrap: auth register', async () => {
    const status = await api('GET', '/api/auth/status', undefined, 200);
    assert(status.json.needsSetup === true, 'expected needsSetup=true');
    const reg = await api('POST', '/api/auth/register', USER, 200);
    assert(reg.json.token, 'no token in register response');
    token = reg.json.token;
  });

  await check('bootstrap: throwaway DB has the kept auto_doc_sessions table', async () => {
    await openDb();
    assert(tableExists('auto_doc_sessions'), 'auto_doc_sessions table is missing');
    const n = autoDocCount();
    assert(n === 0, 'fresh throwaway DB should have 0 auto_doc_sessions rows, got ' + n);
    return 'table present, 0 rows';
  });

  // ── #1 settings contract ────────────────────────────────────────────────────
  await check('#1a GET/PUT /api/settings/auto-doc are gone (404)', async () => {
    const get = await apiRaw('GET', '/api/settings/auto-doc');
    const put = await apiRaw('PUT', '/api/settings/auto-doc', { enabled: true });
    const detail = 'GET=' + get.status + (get.location ? ' -> Location: ' + get.location : '') + ', PUT=' + put.status;
    assert(get.status === 404 && put.status === 404, 'expected both 404, got ' + detail);
    return 'GET and PUT both 404';
  });

  await check('#1b GET /api/settings/automations returns only hideScheduledTaskSessions', async () => {
    const { json } = await api('GET', '/api/settings/automations', undefined, 200);
    const keys = Object.keys(json).sort();
    assert(JSON.stringify(keys) === JSON.stringify(['hideScheduledTaskSessions']), 'unexpected keys: ' + JSON.stringify(keys));
    assert(json.hideScheduledTaskSessions === true, 'hideScheduledTaskSessions must default to true');
    return 'keys=[' + keys.join(',') + '], default true';
  });

  await check('#1c POST /api/settings/automations ignores legacy auto-doc keys (200)', async () => {
    const legacy = { hideAutoDoc: true, intervalMs: 60000, prompt: 'legacy', minMessageCount: 3, model: 'claude', enabled: true };
    const res = await api('POST', '/api/settings/automations', legacy, 200);
    assert(res.json.success === true, 'legacy POST should return success');
    for (const key of Object.keys(legacy)) {
      assert(!(key in res.json), 'legacy key leaked into the response: ' + key);
    }
    assert(res.json.hideScheduledTaskSessions === true, 'legacy POST must not change the scheduled-task flag');
    const setFalse = await api('POST', '/api/settings/automations', { hideScheduledTaskSessions: false }, 200);
    assert(setFalse.json.hideScheduledTaskSessions === false, 'hideScheduledTaskSessions=false not applied');
    const read = await api('GET', '/api/settings/automations', undefined, 200);
    assert(read.json.hideScheduledTaskSessions === false, 'setting not persisted');
    await api('POST', '/api/settings/automations', { hideScheduledTaskSessions: true }, 200);
    return 'legacy keys ignored, supported flag still works';
  });

  // ── #2 timer gone + auto_doc_sessions stable ────────────────────────────────
  await sleep(1200);
  await check('#2a no [auto-doc] output in the server log', async () => {
    const log = readTextFile(child.logPath);
    assert(log.indexOf('[auto-doc]') === -1, 'found [auto-doc] in the server log');
    return 'log clean (' + log.length + ' bytes)';
  });

  await check('#2b auto_doc_sessions rows are stable while the server runs', async () => {
    insertAutoDocRow('verify-historical-1', 'verify-historical-source-1', '2024-01-01T00:00:00.000Z');
    insertAutoDocRow('verify-historical-2', 'verify-historical-source-2', '2024-01-02T00:00:00.000Z');
    expectedAutoDocRows.value = autoDocCount();
    assert(expectedAutoDocRows.value === 2, 'expected 2 seeded rows, got ' + expectedAutoDocRows.value);
    await sleep(1200);
    const after = autoDocCount();
    assert(after === expectedAutoDocRows.value, 'auto_doc_sessions grew from ' + expectedAutoDocRows.value + ' to ' + after);
    assert(tableExists('auto_doc_sessions'), 'auto_doc_sessions table disappeared');
    return after + ' rows, table present';
  });

  // ── #3 /api/projects sessions are undecorated ───────────────────────────────
  await check('#3a a session present in auto_doc_sessions comes back as an ordinary session', async () => {
    const created = await api('POST', '/api/projects/create', { path: PROJECT_DOC });
    if (created.status === 200) {
      assert(created.json && created.json.success === true, 'project create failed: ' + created.text);
    } else {
      assert(created.status === 500 && /already configured/i.test(created.text), 'unexpected project create response: ' + created.status + ' ' + created.text);
    }
    writeTranscriptFixture();
    // Force the JSONL index sync (sync-on-miss) for this unique project.
    const synced = await api('GET', '/api/projects/' + encodeURIComponent(PROJECT_ENC) + '/sessions?limit=20', undefined, 200);
    const syncedIds = (synced.json.sessions || []).map((s) => s.id);
    assert(syncedIds.indexOf(SID) >= 0, 'fixture session was not indexed: ' + JSON.stringify(syncedIds));

    // The retired AutoDoc table is now inert: a row in it must not hide or badge anything.
    insertAutoDocRow(SID, SRC_SID, '2024-01-03T00:00:00.000Z');
    expectedAutoDocRows.value = autoDocCount();
    assert(hasAutoDocRow(SID), 'fixture row missing from auto_doc_sessions');

    const projects = await api('GET', '/api/projects', undefined, 200);
    assert(Array.isArray(projects.json), '/api/projects did not return an array');
    const project = projects.json.find((p) => p.path === PROJECT_DOC || p.fullPath === PROJECT_DOC);
    assert(project, 'project not in /api/projects: ' + JSON.stringify(projects.json.map((p) => p.path)));
    const ids = (project.sessions || []).map((s) => s.id);
    assert(ids.indexOf(SID) >= 0, 'auto_doc session was filtered out: ' + JSON.stringify(ids));
    assert(ids.indexOf(SRC_SID) >= 0, 'source session missing: ' + JSON.stringify(ids));
    for (const session of project.sessions || []) {
      assert(!('isAutoDoc' in session), 'session carries isAutoDoc: ' + session.id);
      assert(!('lastAutoDocAt' in session), 'session carries lastAutoDocAt: ' + session.id);
    }
    return project.sessions.length + ' sessions, no AutoDoc decoration';
  });

  // ── #4 preset seeds / installs / gate skips ─────────────────────────────────
  const base = '/api/scheduled-tasks';
  let autoDocTask = null;

  await check('#4a builtin auto-doc preset seeds and lists with template auto-doc-docs-refresh', async () => {
    const { json } = await api('GET', base + '/presets', undefined, 200);
    const preset = (json.presets || []).find((p) => p.id === 'auto-doc');
    assert(preset, 'auto-doc preset not in the catalog');
    assert(preset.source === 'builtin', 'auto-doc preset should be builtin');
    assert(preset.tasks.length === 1, 'auto-doc preset should have exactly one template');
    const template = preset.tasks[0];
    assert(template.id === 'auto-doc-docs-refresh', 'template id mismatch: ' + template.id);
    assert(template.kind === 'daily', 'template kind mismatch: ' + template.kind);
    assert(template.rule.time === '21:00', 'template time mismatch: ' + template.rule.time);
    assert(template.rule.timeZone === 'Asia/Shanghai', 'template timezone mismatch: ' + template.rule.timeZone);
    assert(String(template.command || '').indexOf('autodoc-cursor.json') >= 0, 'gate does not use the cursor file');
    return preset.id + ' / ' + template.id;
  });

  await check('#4b install defaults to enabled and materializes the task', async () => {
    const { json } = await api('POST', base + '/presets/auto-doc/install', { projectPath: PROJECT_EMPTY }, 200);
    assert(json.preset.enabled === true, 'install should default enabled=true');
    assert(json.created.length === 1, 'expected 1 created task, got ' + json.created.length);
    assert(json.tasks.length === 1, 'expected 1 materialized task');
    autoDocTask = json.tasks[0];
    assert(autoDocTask.enabled === true, 'installed task should be enabled');
    assert(autoDocTask.presetTaskId === 'auto-doc-docs-refresh', 'presetTaskId mismatch');
    assert(autoDocTask.nextRunAt && Date.parse(autoDocTask.nextRunAt) > Date.now(), 'nextRunAt not computed');
    const taskDir = path.join(DATA_DIR, autoDocTask.id);
    assert(fs.existsSync(path.join(taskDir, 'state')), 'task state dir missing after install');
    return autoDocTask.id + ' enabled, run ' + autoDocTask.nextRunAt;
  });

  await check('#4c the gate skips a project without new conversations (no model call)', async () => {
    assert(autoDocTask, 'no installed task (see #4b)');
    assert(!fs.existsSync(EMPTY_CLAUDE_DIR), 'fixture project unexpectedly has Claude transcripts: ' + EMPTY_CLAUDE_DIR);
    const started = (await api('POST', base + '/' + autoDocTask.id + '/run', undefined, 202)).json.run;
    assert(started && started.id, 'no run row returned');
    const finished = await poll('auto-doc gate run to finish', async () => {
      const runs = (await api('GET', base + '/' + autoDocTask.id + '/runs?limit=5', undefined, 200)).json.runs;
      const found = runs.find((r) => r.id === started.id);
      return found && found.status !== 'running' ? found : null;
    });
    assert(finished.status === 'skipped', 'expected skipped, got ' + finished.status + ' err=' + finished.error);
    assert(String(finished.output).indexOf('no new conversations since') === 0, 'reason mismatch: ' + JSON.stringify(finished.output));
    assert(finished.promptUsed === null, 'a skipped run must not carry prompt_used');
    assert(finished.sessionId === null, 'a skipped run must not start a session (no model call)');
    assert(String(finished.output).indexOf('[dry-run]') === -1, 'skipped run reached the agent path');
    assert(finished.scriptExitCode === 0, 'gate exit code ' + finished.scriptExitCode);
    expectedAutoDocRows.value = autoDocCount();
    return JSON.stringify(finished.output);
  });

  // ── #5 history survives a restart, then final stability ─────────────────────
  await check('#5 auto_doc_sessions history survives a server restart', async () => {
    await stopServer();
    child = startServer();
    await waitForHealth();
    let login;
    try {
      login = await api('POST', '/api/auth/login', USER, 200);
    } catch (err) {
      throw new Error(err.message + ' | childExit=' + (child && child.proc.exitCode) + ' | log: ' + tailLog(30));
    }
    assert(login.json.token, 're-login after restart failed');
    token = login.json.token;

    assert(tableExists('auto_doc_sessions'), 'table dropped across restart');
    assert(hasAutoDocRow('verify-historical-1'), 'historical row 1 lost across restart');
    assert(hasAutoDocRow('verify-historical-2'), 'historical row 2 lost across restart');
    assert(hasAutoDocRow(SID), 'fixture auto-doc row lost across restart');
    const after = autoDocCount();
    assert(after === expectedAutoDocRows.value, 'row count changed across restart: ' + expectedAutoDocRows.value + ' -> ' + after);
    const log = readTextFile(child.logPath);
    assert(log.indexOf('[auto-doc]') === -1, 'found [auto-doc] in the server log after restart');
    return after + ' rows kept across restart, still no [auto-doc]';
  });

  await check('guard ~/.claudecodeui/scheduled-tasks is untouched', async () => {
    const after = snapshotDir(HOME_DATA_DIR);
    assert(JSON.stringify(after) === JSON.stringify(homeBefore), 'home data dir changed: ' + JSON.stringify(homeBefore) + ' -> ' + JSON.stringify(after));
    return after.length + ' entries, unchanged';
  });
}

main()
  .catch((err) => {
    failures.push('fatal: ' + (err && err.stack ? err.stack : err));
    console.log('');
    console.log('FATAL: ' + (err && err.message ? err.message : err));
    if (child) console.log('--- server log tail ---' + LF + tailLog(40));
  })
  .finally(async () => {
    await stopServer();
    console.log('');
    console.log('[autodoc-e2e] ' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const f of failures) console.log('  - ' + f);
      process.exitCode = 1;
    } else {
      console.log('[autodoc-e2e] OK');
    }
    if (db) { try { db.close(); } catch { /* ignore */ } }
    if (fs.existsSync(CLAUDE_DIR) && CLAUDE_DIR.startsWith(CLAUDE_PROJECTS)) {
      fs.rmSync(CLAUDE_DIR, { recursive: true, force: true });
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
