#!/usr/bin/env node
/**
 * End-to-end acceptance check for the Scheduled Tasks feature (lead-owned).
 *
 * Boots the real server (tsx) against a throwaway SQLite database with
 * SCHEDULED_TASK_DRY_RUN=1 and SCHEDULED_TASKS_TICK_MS=1000, then exercises the
 * full REST surface: auth bootstrap -> CRUD -> validation -> manual run ->
 * timer-driven fire -> one-shot exhaustion -> restart persistence -> delete.
 *
 * Usage: node scripts/verify-scheduled-tasks.mjs
 * Exit code 0 = all checks passed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// better-sqlite3 ships a native binding compiled for Node 22 (see .nvmrc). When the
// active node is newer, the server crashes on getConnection(); force the Node 22 bin
// dir onto PATH for the spawned server (and for this process's child tooling).
function resolveNodeBinDir() {
  if (process.env.E2E_NODE_BIN) return process.env.E2E_NODE_BIN;
  const nvmBin = path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.17.0', 'bin');
  if (fs.existsSync(path.join(nvmBin, 'node'))) return nvmBin;
  return null;
}

const NODE_BIN_DIR = resolveNodeBinDir();
if (NODE_BIN_DIR) console.log('[e2e] using node bin dir: ' + NODE_BIN_DIR + ' (current: ' + process.version + ')');
else if (process.version !== 'v22.17.0') console.warn('[e2e] WARNING: no Node 22 bin dir found; better-sqlite3 may fail to load under ' + process.version);
const PORT = Number(process.env.E2E_PORT || 3487);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-e2e-'));
const DB_PATH = path.join(TMP, 'auth.db');
const USER = { username: 'e2euser', password: 'e2e-password' };

let child = null;
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const out = fn();
    passed += 1;
    console.log('  PASS  ' + name + (out === undefined ? '' : '  -> ' + out));
  } catch (err) {
    failures.push(name + ': ' + err.message);
    console.log('  FAIL  ' + name + '  -> ' + err.message);
  }
}

async function checkAsync(name, fn) {
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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function startServer() {
  const env = {
    ...process.env,
    ...(NODE_BIN_DIR ? { PATH: NODE_BIN_DIR + path.delimiter + process.env.PATH } : {}),
    SERVER_PORT: String(PORT),
    VITE_PORT: '5199',
    DATABASE_PATH: DB_PATH,
    SCHEDULED_TASKS_ENABLED: '1',
    SCHEDULED_TASKS_TICK_MS: '1000',
    SCHEDULED_TASK_DRY_RUN: '1',
    NODE_ENV: 'production',
  };
  const proc = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.js'], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logPath = path.join(TMP, 'server.log');
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  proc.stdout.pipe(stream);
  proc.stderr.pipe(stream);
  proc.on('exit', (code) => stream.write('\n[server exited ' + code + ']\n'));
  return { proc, logPath };
}

async function stopServer() {
  if (!child) return;
  const proc = child.proc;
  child = null;
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  for (let i = 0; i < 50 && proc.exitCode === null; i += 1) await sleep(100);
  if (proc.exitCode === null) proc.kill('SIGKILL');
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

function tailLog(lines = 25) {
  if (!child) return '(no server)';
  try {
    return fs.readFileSync(child.logPath, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(unreadable log)';
  }
}

let token = null;
async function api(method, url, body, expect) {
  const res = await fetch(BASE + url, {
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

async function poll(label, fn, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error('timed out waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
}

async function main() {
  console.log('[e2e] temp dir:', TMP);
  child = startServer();
  await waitForHealth();

  // ── auth bootstrap ────────────────────────────────────────────────────────
  await checkAsync('auth status reports setup required', async () => {
    const { json } = await api('GET', '/api/auth/status', undefined, 200);
    assert(json.needsSetup === true, 'expected needsSetup=true, got ' + JSON.stringify(json));
  });
  await checkAsync('register creates the single user and returns a token', async () => {
    const { json } = await api('POST', '/api/auth/register', USER, 200);
    assert(json.token, 'no token in response');
    token = json.token;
  });

  const base = '/api/scheduled-tasks';

  await checkAsync('list starts empty', async () => {
    const { json } = await api('GET', base, undefined, 200);
    assert(Array.isArray(json.tasks), 'tasks is not an array');
    assert(json.tasks.length === 0, 'expected 0 tasks, got ' + json.tasks.length);
  });

  // ── validation ────────────────────────────────────────────────────────────
  await checkAsync('reject missing title', async () => {
    const { json } = await api('POST', base, { prompt: 'x', projectPath: TMP, rule: { kind: 'interval', everySeconds: 60 } }, 400);
    assert(json.code, 'expected an error code');
  });
  await checkAsync('reject interval below 60s', async () => {
    const { json } = await api('POST', base, { title: 'bad', prompt: 'x', projectPath: TMP, rule: { kind: 'interval', everySeconds: 5 } }, 400);
    assert(json.code === 'invalid_interval', 'expected invalid_interval, got ' + json.code);
  });
  await checkAsync('reject invalid cron expression', async () => {
    const { json } = await api('POST', base, { title: 'bad cron', prompt: 'x', projectPath: TMP, rule: { kind: 'cron', expression: 'not a cron', timeZone: 'Asia/Shanghai' } }, 400);
    assert(json.code === 'invalid_cron' || json.code === 'invalid_rule', 'unexpected code ' + json.code);
  });
  await checkAsync('reject unknown timezone', async () => {
    const { json } = await api('POST', base, { title: 'bad tz', prompt: 'x', projectPath: TMP, rule: { kind: 'daily', time: '09:00:00', timeZone: 'Mars/Olympus' } }, 400);
    assert(json.code === 'invalid_time_zone' || json.code === 'invalid_rule', 'unexpected code ' + json.code);
  });

  // ── create / read / patch ─────────────────────────────────────────────────
  let intervalTask = null;
  await checkAsync('create interval task (201) with a computed nextRunAt', async () => {
    const { json } = await api('POST', base, {
      title: 'Queue check', prompt: 'Check the queue', projectPath: TMP,
      rule: { kind: 'interval', everySeconds: 600 },
    }, 201);
    intervalTask = json.task;
    assert(intervalTask.id, 'no id');
    assert(intervalTask.kind === 'interval', 'kind mismatch');
    assert(intervalTask.enabled === true, 'expected enabled');
    assert(intervalTask.nextRunAt && !Number.isNaN(Date.parse(intervalTask.nextRunAt)), 'nextRunAt missing/invalid: ' + intervalTask.nextRunAt);
    assert(intervalTask.rule && intervalTask.rule.everySeconds === 600, 'rule not echoed: ' + JSON.stringify(intervalTask.rule));
    const delta = Date.parse(intervalTask.nextRunAt) - Date.now();
    assert(delta > 500 * 1000 && delta < 700 * 1000, 'nextRunAt not ~600s out: ' + delta + 'ms');
  });

  await checkAsync('get task by id', async () => {
    const { json } = await api('GET', base + '/' + intervalTask.id, undefined, 200);
    assert(json.task.id === intervalTask.id, 'id mismatch');
    assert(json.task.prompt === 'Check the queue', 'prompt mismatch');
  });

  await checkAsync('list filter + search', async () => {
    const all = (await api('GET', base + '?status=all', undefined, 200)).json.tasks;
    assert(all.length === 1, 'expected 1 task, got ' + all.length);
    const hit = (await api('GET', base + '?search=queue', undefined, 200)).json.tasks;
    assert(hit.length === 1, 'search should match title');
    const miss = (await api('GET', base + '?search=zzz-nope', undefined, 200)).json.tasks;
    assert(miss.length === 0, 'search should not match');
  });

  await checkAsync('patch title + enabled', async () => {
    const { json } = await api('PATCH', base + '/' + intervalTask.id, { title: 'Queue check v2', enabled: false }, 200);
    assert(json.task.title === 'Queue check v2', 'title not updated');
    assert(json.task.enabled === false, 'enabled not updated');
    assert(json.task.nextRunAt === null, 'paused task should have nextRunAt=null, got ' + json.task.nextRunAt);
    const paused = (await api('GET', base + '?status=paused', undefined, 200)).json.tasks;
    assert(paused.length === 1, 'paused filter should return it');
    const active = (await api('GET', base + '?status=active', undefined, 200)).json.tasks;
    assert(active.length === 0, 'active filter should be empty');
  });

  await checkAsync('re-enable recomputes nextRunAt', async () => {
    const { json } = await api('PATCH', base + '/' + intervalTask.id, { enabled: true }, 200);
    assert(json.task.enabled === true, 'not re-enabled');
    assert(json.task.nextRunAt, 'nextRunAt not recomputed');
  });

  await checkAsync('404 for unknown id', async () => {
    await api('GET', base + '/does-not-exist', undefined, 404);
    await api('DELETE', base + '/does-not-exist', undefined, 404);
    await api('POST', base + '/does-not-exist/run', undefined, 404);
  });

  // ── manual run (dry-run) ──────────────────────────────────────────────────
  await checkAsync('manual run returns a running run row and finishes as dry-run success', async () => {
    const { json } = await api('POST', base + '/' + intervalTask.id + '/run', undefined, 202);
    const run = json.run;
    assert(run && run.id, 'no run row returned');
    assert(run.status === 'running', 'expected running, got ' + run.status);
    assert(run.trigger === 'manual', 'expected trigger=manual, got ' + run.trigger);
    const finished = await poll('manual run to finish', async () => {
      const runs = (await api('GET', base + '/' + intervalTask.id + '/runs?limit=5', undefined, 200)).json.runs;
      const found = runs.find((r) => r.id === run.id);
      return found && found.status !== 'running' ? found : null;
    });
    assert(finished.status === 'success', 'expected success, got ' + finished.status + ' err=' + finished.error);
    assert(String(finished.output || '').includes('[dry-run]'), 'expected dry-run output, got ' + JSON.stringify(finished.output));
  });

  await checkAsync('runs listing reports total', async () => {
    const { json } = await api('GET', base + '/' + intervalTask.id + '/runs', undefined, 200);
    assert(json.total >= 1, 'expected total >= 1, got ' + json.total);
    assert(json.runs.length >= 1, 'no runs returned');
    assert(json.runs[0].taskId === intervalTask.id, 'taskId mismatch');
  });

  // ── timer-driven fire ─────────────────────────────────────────────────────
  let oneShotId = null;
  await checkAsync('a one-shot task fires on the timer and then reports nextRunAt=null', async () => {
    const at = new Date(Date.now() + 3000).toISOString();
    const { json } = await api('POST', base, {
      title: 'One shot', prompt: 'Run once', projectPath: TMP, rule: { kind: 'once', at },
    }, 201);
    const task = json.task;
    oneShotId = task.id;
    assert(task.kind === 'once', 'kind mismatch: ' + task.kind);
    assert(Date.parse(task.nextRunAt) - Date.parse(at) === 0, 'nextRunAt should equal the requested at');
    const done = await poll('one-shot task to fire', async () => {
      const t = (await api('GET', base + '/' + task.id, undefined, 200)).json.task;
      return t.runCount >= 1 && t.lastStatus ? t : null;
    }, { timeoutMs: 30000 });
    assert(done.nextRunAt === null, 'one-shot nextRunAt should be null after firing, got ' + done.nextRunAt);
    assert(done.runCount >= 1, 'runCount not incremented');
    assert(done.lastStatus === 'success', 'lastStatus=' + done.lastStatus + ' err=' + done.lastError);
    const runs = (await api('GET', base + '/' + task.id + '/runs', undefined, 200)).json.runs;
    const scheduled = runs.find((r) => r.trigger === 'schedule');
    assert(scheduled, 'no run with trigger=schedule');
    assert(String(scheduled.output || '').includes('[dry-run]'), 'scheduled run was not the dry-run path');
  });

  await checkAsync('cron task is accepted and computes a future nextRunAt', async () => {
    const { json } = await api('POST', base, {
      title: 'Cron deploy check', prompt: 'Check the deploy', projectPath: TMP,
      rule: { kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'Asia/Shanghai' },
    }, 201);
    assert(json.task.kind === 'cron', 'kind mismatch');
    assert(Date.parse(json.task.nextRunAt) > Date.now(), 'cron nextRunAt not in the future');
    const d = new Date(json.task.nextRunAt);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    assert(Number(get('minute')) % 15 === 0, 'cron minute not on a 15-minute boundary: ' + get('minute'));
    await api('DELETE', base + '/' + json.task.id, undefined, 200);
  });

  // ── restart persistence ───────────────────────────────────────────────────
  const survivorTitle = 'Survives restart';
  let survivorId = null;
  await checkAsync('create a task that must survive a server restart', async () => {
    const { json } = await api('POST', base, {
      title: survivorTitle, prompt: 'persist me', projectPath: TMP,
      rule: { kind: 'daily', time: '09:30:00', timeZone: 'Asia/Shanghai' },
    }, 201);
    survivorId = json.task.id;
    // The rule engine canonicalizes '09:30:00' to '09:30' (seconds are omitted when zero).
    assert(/^09:30(:00)?$/.test(String(json.task.rule.time)), 'rule time not preserved: ' + JSON.stringify(json.task.rule));
    assert(json.task.rule.hour === 9 && json.task.rule.minute === 30, 'rule hour/minute not preserved');
  });
  await stopServer();
  child = startServer();
  await waitForHealth();
  await checkAsync('restart + login, task still present with a future nextRunAt', async () => {
    const { json } = await api('POST', '/api/auth/login', USER, 200);
    token = json.token;
    const t = (await api('GET', base + '/' + survivorId, undefined, 200)).json.task;
    assert(t.title === survivorTitle, 'title lost');
    assert(t.rule.timeZone === 'Asia/Shanghai', 'timezone lost');
    assert(Date.parse(t.nextRunAt) > Date.now(), 'nextRunAt not in the future after restart');
  });

  // ── delete ────────────────────────────────────────────────────────────────
  await checkAsync('delete removes tasks and their runs', async () => {
    const del = await api('DELETE', base + '/' + intervalTask.id, undefined, 200);
    assert(del.json.deleted === true, 'deleted flag missing');
    await api('GET', base + '/' + intervalTask.id, undefined, 404);
    await api('GET', base + '/' + intervalTask.id + '/runs', undefined, 404);
    const remaining = (await api('GET', base, undefined, 200)).json.tasks;
    assert(remaining.every((t) => t.id !== intervalTask.id), 'deleted task still listed');
    if (oneShotId) await api('DELETE', base + '/' + oneShotId, undefined, 200);
    await api('DELETE', base + '/' + survivorId, undefined, 200);
    const finalTasks = (await api('GET', base, undefined, 200)).json.tasks;
    assert(finalTasks.length === 0, 'expected 0 tasks at the end, got ' + finalTasks.length);
  });
}

main()
  .catch((err) => {
    failures.push('fatal: ' + (err && err.stack ? err.stack : err));
    console.log('\nFATAL: ' + (err && err.message ? err.message : err));
    if (child) console.log('--- server log tail ---\n' + tailLog(40));
  })
  .finally(async () => {
    await stopServer();
    console.log('\n[e2e] ' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const f of failures) console.log('  - ' + f);
      process.exitCode = 1;
    } else {
      console.log('[e2e] OK');
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
