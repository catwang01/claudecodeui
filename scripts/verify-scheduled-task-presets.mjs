#!/usr/bin/env node
/**
 * End-to-end acceptance check for Scheduled Task Presets + per-task workspace
 * (docs/scheduled-tasks.md section 10, issue #4). Lead-owned verification script.
 *
 * Boots the real server (tsx) against a throwaway SQLite database, a throwaway
 * SCHEDULED_TASK_DATA_DIR, SCHEDULED_TASK_DRY_RUN=1 and SCHEDULED_TASKS_TICK_MS=1000,
 * then walks the full REST surface and asserts the nine acceptance bullets of
 * section 10.9:
 *   #1 builtin catalog seeds and lists (>=3, with task previews)
 *   #2 install materializes tasks and is idempotent
 *   #3 a second install with enabled:false pauses the bundle
 *   #4 enable/disable flips the whole preset and every linked task
 *   #5 a custom preset is built from tasks and installs into another project
 *   #6 uninstall of a builtin keeps the catalog; custom delete honours purge=0/1
 *   #7 a dry run materializes the whole on-disk layout
 *   #8 the script gate sees the five SCHEDULED_TASK_* env vars
 *   #9 DELETE /:id keeps the workspace by default and ?purge=1 removes it
 *
 * Extra guard: ~/.claudecodeui/scheduled-tasks must not be touched (the script
 * always points SCHEDULED_TASK_DATA_DIR at its throwaway temp dir).
 *
 * Usage: node scripts/verify-scheduled-task-presets.mjs
 * Exit code 0 = all checks passed; 1 = at least one failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// better-sqlite3 ships a native binding compiled for Node 22 (see .nvmrc). Force
// the Node 22 bin dir onto PATH for the spawned server (and child tooling).
function resolveNodeBinDir() {
  if (process.env.E2E_NODE_BIN) return process.env.E2E_NODE_BIN;
  const nvmBin = path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.17.0', 'bin');
  if (fs.existsSync(path.join(nvmBin, 'node'))) return nvmBin;
  return null;
}

const NODE_BIN_DIR = resolveNodeBinDir();
if (NODE_BIN_DIR) console.log('[presets-e2e] using node bin dir: ' + NODE_BIN_DIR + ' (current: ' + process.version + ')');
else if (process.version !== 'v22.17.0') console.warn('[presets-e2e] WARNING: no Node 22 bin dir found; better-sqlite3 may fail to load under ' + process.version);

const PORT = Number(process.env.E2E_PORT || 3488);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-presets-e2e-'));
const DB_PATH = path.join(TMP, 'auth.db');
const DATA_DIR = path.join(TMP, 'scheduled-task-data');
const PROJECT_A = path.join(TMP, 'project-a');
const PROJECT_B = path.join(TMP, 'project-b');
const HOME_DATA_DIR = path.join(os.homedir(), '.claudecodeui', 'scheduled-tasks');
const USER = { username: 'presetuser', password: 'preset-password' };
const LF = String.fromCharCode(10);

fs.mkdirSync(PROJECT_A, { recursive: true });
fs.mkdirSync(PROJECT_B, { recursive: true });

let child = null;
let token = null;
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

function snapshotDir(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

function readTextFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { throw new Error('cannot read ' + file + ': ' + err.message); }
}

function readJsonFile(file) {
  const text = readTextFile(file);
  try { return JSON.parse(text); } catch (err) { throw new Error('cannot parse JSON ' + file + ': ' + err.message); }
}

function assertFile(file, label) {
  assert(fs.existsSync(file) && fs.statSync(file).isFile(), label + ': missing file ' + file);
}

function assertDir(dir, label) {
  assert(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), label + ': missing dir ' + dir);
}

function startServer() {
  const env = {
    ...process.env,
    ...(NODE_BIN_DIR ? { PATH: NODE_BIN_DIR + path.delimiter + process.env.PATH } : {}),
    SERVER_PORT: String(PORT),
    VITE_PORT: '5198',
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
  });
  const logPath = path.join(TMP, 'server.log');
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  proc.stdout.pipe(stream);
  proc.stderr.pipe(stream);
  proc.on('exit', (code) => stream.write(LF + '[server exited ' + code + ']' + LF));
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

async function main() {
  console.log('[presets-e2e] temp dir: ' + TMP);
  console.log('[presets-e2e] data dir: ' + DATA_DIR);
  assert(DATA_DIR.startsWith(TMP), 'data dir must live under the temp dir');
  const homeBefore = snapshotDir(HOME_DATA_DIR);

  child = startServer();
  await waitForHealth();

  const base = '/api/scheduled-tasks';

  await check('bootstrap: auth register', async () => {
    const status = await api('GET', '/api/auth/status', undefined, 200);
    assert(status.json.needsSetup === true, 'expected needsSetup=true');
    const reg = await api('POST', '/api/auth/register', USER, 200);
    assert(reg.json.token, 'no token in register response');
    token = reg.json.token;
  });

  // ── #1 builtin catalog ──────────────────────────────────────────────────────
  let builtins = [];
  let builtin = null;
  await check('#1 builtin catalog seeds and lists: >=3 presets, each with a task preview', async () => {
    const { json } = await api('GET', base + '/presets', undefined, 200);
    assert(Array.isArray(json.presets), 'presets is not an array');
    builtins = json.presets.filter((p) => p.source === 'builtin');
    assert(builtins.length >= 3, 'expected >=3 builtin presets, got ' + builtins.length);
    for (const p of builtins) {
      assert(p.projectPath === null, 'builtin ' + p.id + ' projectPath should be null');
      assert(Array.isArray(p.tasks) && p.tasks.length >= 1, 'builtin ' + p.id + ' has no task preview');
      assert(p.taskCount === p.tasks.length, 'builtin ' + p.id + ' taskCount != tasks.length');
      for (const t of p.tasks) {
        assert(t.presetId === p.id, 'preview presetId mismatch on ' + p.id);
        assert(t.rule && typeof t.rule.kind === 'string', 'preview rule missing on ' + p.id);
      }
    }
    builtin = builtins.find((p) => p.id === 'dependency-audit') || builtins[0];
    assert(builtin.tasks.length >= 2, 'need a builtin with >=2 templates for the install checks');
    return builtins.length + ' builtins, using ' + builtin.id + ' (' + builtin.tasks.length + ' templates)';
  });

  await check('#1b GET /presets is registered before /:id (single preset fetch works)', async () => {
    assert(builtin, 'no builtin preset resolved (see #1)');
    const { json } = await api('GET', base + '/presets/' + builtin.id, undefined, 200);
    assert(json.preset && json.preset.id === builtin.id, 'preset id mismatch');
    assert(Array.isArray(json.preset.tasks) && json.preset.tasks.length >= 1, 'single preset has no templates');
    return builtin.id;
  });

  // ── #2 install + idempotency ────────────────────────────────────────────────
  let builtinTaskIds = [];
  await check('#2a install materializes one task per template, enabled by default', async () => {
    assert(builtin, 'no builtin preset resolved (see #1)');
    const { json } = await api('POST', base + '/presets/' + builtin.id + '/install', { projectPath: PROJECT_A }, 200);
    assert(json.preset && json.preset.id === builtin.id, 'preset not echoed');
    assert(json.preset.enabled === true, 'install must default enabled=true (lead ruling), got ' + json.preset.enabled);
    assert(Array.isArray(json.skipped), 'skipped array missing');
    assert(json.skipped.length === 0, 'unexpected skipped templates: ' + JSON.stringify(json.skipped));
    assert(json.created.length === builtin.tasks.length, 'created ' + json.created.length + ' != templates ' + builtin.tasks.length);
    assert(json.updated.length === 0, 'first install must not report updates');
    assert(json.tasks.length === builtin.tasks.length, 'tasks length mismatch');
    const templateIds = builtin.tasks.map((t) => t.id).sort();
    for (const t of json.tasks) {
      assert(t.presetId === builtin.id, 'task presetId mismatch: ' + t.presetId);
      assert(templateIds.indexOf(t.presetTaskId) >= 0, 'task presetTaskId is not a template: ' + t.presetTaskId);
      assert(t.enabled === true, 'installed task should be enabled: ' + t.id);
      assert(t.nextRunAt && !Number.isNaN(Date.parse(t.nextRunAt)), 'installed task nextRunAt invalid: ' + t.nextRunAt);
      assert(t.projectPath === PROJECT_A, 'task projectPath mismatch: ' + t.projectPath);
    }
    builtinTaskIds = json.tasks.map((t) => t.id);
    return json.created.length + ' created, ' + json.skipped.length + ' skipped';
  });

  await check('#2b installed tasks are really in the database, linked by presetId', async () => {
    assert(builtinTaskIds.length, 'no tasks installed (see #2a)');
    for (const id of builtinTaskIds) {
      const { json } = await api('GET', base + '/' + id, undefined, 200);
      assert(json.task.presetId === builtin.id, 'GET ' + id + ' presetId mismatch');
      assert(json.task.projectPath === PROJECT_A, 'GET ' + id + ' projectPath mismatch');
    }
    const all = (await api('GET', base + '?status=all', undefined, 200)).json.tasks;
    const mine = all.filter((t) => t.presetId === builtin.id);
    assert(mine.length === builtinTaskIds.length, 'expected ' + builtinTaskIds.length + ' rows, got ' + mine.length);
    return mine.length + ' rows';
  });

  await check('#2c a second install is idempotent (no duplicates, only updated_at moves)', async () => {
    assert(builtinTaskIds.length, 'no tasks installed (see #2a)');
    const before = [];
    for (const id of builtinTaskIds) before.push((await api('GET', base + '/' + id, undefined, 200)).json.task);
    const beforePreset = (await api('GET', base + '/presets/' + builtin.id, undefined, 200)).json.preset;
    await sleep(40);
    const { json } = await api('POST', base + '/presets/' + builtin.id + '/install', { projectPath: PROJECT_A }, 200);
    assert(json.created.length === 0, 'second install created duplicates: ' + JSON.stringify(json.created));
    assert(json.updated.length === builtinTaskIds.length, 'second install should update every linked task');
    const idsAfter = json.tasks.map((t) => t.id).sort();
    const idsBefore = builtinTaskIds.slice().sort();
    assert(JSON.stringify(idsAfter) === JSON.stringify(idsBefore), 'task ids changed: ' + JSON.stringify(idsAfter));
    const all = (await api('GET', base + '?status=all', undefined, 200)).json.tasks.filter((t) => t.presetId === builtin.id);
    assert(all.length === builtinTaskIds.length, 'duplicate rows appeared: ' + all.length);
    for (const task of before) {
      const after = all.find((t) => t.id === task.id);
      assert(after, 'task vanished: ' + task.id);
      assert(Date.parse(after.updatedAt) > Date.parse(task.updatedAt), 'updated_at did not move for ' + task.id);
    }
    const afterPreset = (await api('GET', base + '/presets/' + builtin.id, undefined, 200)).json.preset;
    assert(Date.parse(afterPreset.updatedAt) > Date.parse(beforePreset.updatedAt), 'preset updated_at did not move');
    return idsAfter.length + ' tasks, 0 duplicates';
  });

  // ── #3 install paused ───────────────────────────────────────────────────────
  await check('#3 install with enabled:false pauses the whole bundle', async () => {
    assert(builtin, 'no builtin preset resolved (see #1)');
    const { json } = await api('POST', base + '/presets/' + builtin.id + '/install', { projectPath: PROJECT_A, enabled: false }, 200);
    assert(json.preset.enabled === false, 'preset.enabled should be false, got ' + json.preset.enabled);
    assert(json.created.length === 0, 'enabled:false install should not create tasks');
    assert(json.tasks.length === builtinTaskIds.length, 'task count changed');
    for (const t of json.tasks) {
      assert(t.enabled === false, 'task ' + t.id + ' should be disabled');
      assert(t.nextRunAt === null, 'paused task nextRunAt should be null, got ' + t.nextRunAt);
    }
    return 'preset + ' + json.tasks.length + ' tasks paused';
  });

  // ── #4 whole-preset enable / disable ────────────────────────────────────────
  await check('#4a preset disable flips the preset and every linked task', async () => {
    assert(builtin, 'no builtin preset resolved (see #1)');
    await api('POST', base + '/presets/' + builtin.id + '/enable', { projectPath: PROJECT_A }, 200);
    const { json } = await api('POST', base + '/presets/' + builtin.id + '/disable', { projectPath: PROJECT_A }, 200);
    assert(json.preset.enabled === false, 'disable did not flip the preset flag');
    assert(json.tasks.length === builtinTaskIds.length, 'task count changed');
    for (const t of json.tasks) {
      assert(t.enabled === false, 'disable left task enabled: ' + t.id);
      assert(t.nextRunAt === null, 'disable left nextRunAt set: ' + t.nextRunAt);
    }
    const db = (await api('GET', base + '?status=all', undefined, 200)).json.tasks.filter((t) => t.presetId === builtin.id);
    assert(db.every((t) => t.enabled === false && t.nextRunAt === null), 'database rows not paused');
    return 'preset + ' + json.tasks.length + ' tasks disabled';
  });

  await check('#4b preset enable flips everything back and recomputes the next run', async () => {
    assert(builtin, 'no builtin preset resolved (see #1)');
    const { json } = await api('POST', base + '/presets/' + builtin.id + '/enable', { projectPath: PROJECT_A }, 200);
    assert(json.preset.enabled === true, 'enable did not flip the preset flag');
    assert(json.tasks.length === builtinTaskIds.length, 'task count changed');
    for (const t of json.tasks) {
      assert(t.enabled === true, 'enable left task disabled: ' + t.id);
      assert(t.nextRunAt && Date.parse(t.nextRunAt) > Date.now(), 'nextRunAt not recomputed for ' + t.id);
    }
    return json.tasks.length + ' tasks enabled';
  });

  await check('#4c enable/disable of a not-installed preset records the flag, tasks: []', async () => {
    const other = builtins.find((p) => p.id !== builtin.id);
    assert(other, 'no second builtin preset to probe');
    const on = await api('POST', base + '/presets/' + other.id + '/enable', { projectPath: PROJECT_A }, 200);
    assert(on.json.preset.enabled === true, 'enable flag not recorded');
    assert(Array.isArray(on.json.tasks) && on.json.tasks.length === 0, 'expected tasks: []');
    const off = await api('POST', base + '/presets/' + other.id + '/disable', { projectPath: PROJECT_A }, 200);
    assert(off.json.preset.enabled === false, 'disable flag not recorded');
    assert(off.json.tasks.length === 0, 'expected tasks: []');
    return other.id + ' flag recorded, tasks []';
  });

  // ── #5 custom preset + unscoped install ─────────────────────────────────────
  let custom = null;
  let customTaskIds = [];
  await check('#5a create a custom preset from the current project tasks', async () => {
    assert(builtinTaskIds.length >= 2, 'need >=2 source tasks (see #2)');
    const source = [];
    for (const id of builtinTaskIds) source.push((await api('GET', base + '/' + id, undefined, 200)).json.task);
    const { json } = await api('POST', base + '/presets', {
      name: 'My bundle',
      description: 'made by the acceptance check',
      projectPath: PROJECT_A,
      taskIds: builtinTaskIds,
    }, 201);
    custom = json.preset;
    assert(custom.source === 'custom', 'source should be custom');
    assert(custom.enabled === false, 'a new custom preset should start disabled');
    assert(custom.projectPath === PROJECT_A, 'custom projectPath mismatch: ' + custom.projectPath);
    assert(custom.taskCount === builtinTaskIds.length, 'taskCount mismatch');
    assert(custom.tasks.length === builtinTaskIds.length, 'tasks length mismatch');
    for (let i = 0; i < custom.tasks.length; i += 1) {
      assert(custom.tasks[i].position === i, 'position mismatch at ' + i);
      assert(custom.tasks[i].title === source[i].title, 'snapshot title mismatch at ' + i);
      assert(custom.tasks[i].prompt === source[i].prompt, 'snapshot prompt mismatch at ' + i);
      assert(custom.tasks[i].kind === source[i].kind, 'snapshot kind mismatch at ' + i);
    }
    customTaskIds = custom.tasks.map((t) => t.id);
    return custom.id + ' (' + custom.tasks.length + ' templates, order preserved)';
  });

  await check('#5b custom preset discovery is project-scoped', async () => {
    assert(custom, 'no custom preset (see #5a)');
    const forA = (await api('GET', base + '/presets?projectPath=' + encodeURIComponent(PROJECT_A), undefined, 200)).json.presets;
    assert(forA.some((p) => p.id === custom.id), 'custom preset missing for its own project');
    const forB = (await api('GET', base + '/presets?projectPath=' + encodeURIComponent(PROJECT_B), undefined, 200)).json.presets;
    assert(!forB.some((p) => p.id === custom.id), 'custom preset leaked into the other project listing');
    assert(forB.filter((p) => p.source === 'builtin').length >= 3, 'builtins should always be listed');
    await api('GET', base + '/presets/' + custom.id + '?projectPath=' + encodeURIComponent(PROJECT_B), undefined, 404);
    await api('GET', base + '/presets/' + custom.id + '?projectPath=' + encodeURIComponent(PROJECT_A), undefined, 200);
    return 'scoped to its own project, 404 elsewhere';
  });

  let customInstalledInB = [];
  await check('#5c install is unscoped: the custom preset materializes into another project', async () => {
    assert(custom, 'no custom preset (see #5a)');
    const { json } = await api('POST', base + '/presets/' + custom.id + '/install', { projectPath: PROJECT_B }, 200);
    assert(json.created.length === customTaskIds.length, 'created ' + json.created.length + ' != templates ' + customTaskIds.length);
    assert(json.tasks.length === customTaskIds.length, 'tasks length mismatch');
    for (const t of json.tasks) {
      assert(t.projectPath === PROJECT_B, 'task not materialized in project B: ' + t.projectPath);
      assert(t.presetId === custom.id, 'presetId mismatch: ' + t.presetId);
      assert(t.enabled === true, 'install must default enabled=true (lead ruling)');
      assert(t.nextRunAt && Date.parse(t.nextRunAt) > Date.now(), 'nextRunAt not computed');
    }
    const after = (await api('GET', base + '/presets/' + custom.id, undefined, 200)).json.preset;
    assert(after.projectPath === PROJECT_A, 'install must not rewrite the preset projectPath');
    assert(after.installedProjects.indexOf(PROJECT_B) >= 0, 'installedProjects should include B: ' + JSON.stringify(after.installedProjects));
    assert(after.enabled === true, 'install should have enabled the preset flag');
    customInstalledInB = json.tasks.map((t) => t.id);
    return json.created.length + ' tasks materialized in project B';
  });

  // ── #6 uninstall / purge ────────────────────────────────────────────────────
  await check('#6a uninstall a builtin: linked tasks go, the catalog row stays', async () => {
    assert(builtin, 'no builtin preset resolved (see #1)');
    const { json } = await api('DELETE', base + '/presets/' + builtin.id + '?projectPath=' + encodeURIComponent(PROJECT_A), undefined, 200);
    assert(json.deleted === true, 'deleted flag missing');
    assert(json.id === builtin.id, 'id mismatch');
    assert(json.removedTasks === builtinTaskIds.length, 'removedTasks ' + json.removedTasks + ' != ' + builtinTaskIds.length);
    for (const id of builtinTaskIds) await api('GET', base + '/' + id, undefined, 404);
    const row = (await api('GET', base + '/presets/' + builtin.id, undefined, 200)).json.preset;
    assert(row.source === 'builtin', 'catalog row disappeared');
    assert(row.enabled === false, 'uninstall should leave the preset disabled');
    assert(row.installedProjects.length === 0, 'installedProjects should be empty: ' + JSON.stringify(row.installedProjects));
    assert(row.tasks.length === builtin.tasks.length, 'catalog templates should stay');
    assert(custom, 'custom preset should survive the builtin uninstall');
    await api('GET', base + '/presets/' + custom.id, undefined, 200);
    return json.removedTasks + ' tasks removed, catalog row + templates kept';
  });

  await check('#6b delete a custom preset with purge=0 keeps the installed tasks', async () => {
    assert(custom && customInstalledInB.length, 'no custom preset installed in B (see #5c)');
    const { json } = await api('DELETE', base + '/presets/' + custom.id + '?purge=0', undefined, 200);
    assert(json.deleted === true, 'deleted flag missing');
    assert(json.removedTasks === 0, 'purge=0 removed ' + json.removedTasks + ' tasks');
    await api('GET', base + '/presets/' + custom.id, undefined, 404);
    for (const id of customInstalledInB) await api('GET', base + '/' + id, undefined, 200);
    return 'preset dropped, ' + customInstalledInB.length + ' tasks kept';
  });

  await check('#6c delete a custom preset with the default purge removes its installed tasks', async () => {
    assert(customInstalledInB.length, 'no orphan tasks to bundle (see #6b)');
    const created = (await api('POST', base + '/presets', {
      name: 'Purge me',
      projectPath: PROJECT_B,
      taskIds: customInstalledInB,
    }, 201)).json.preset;
    assert(created.tasks.length === customInstalledInB.length, 'second custom preset templates mismatch');
    // A custom preset only links real tasks once it is installed, so install it first
    // and purge those freshly materialized rows (REST default purge=1).
    const installed = (await api('POST', base + '/presets/' + created.id + '/install', { projectPath: PROJECT_B }, 200)).json;
    assert(installed.created.length === customInstalledInB.length, 'second custom preset install created ' + installed.created.length);
    const installedIds = installed.created.slice();
    const { json } = await api('DELETE', base + '/presets/' + created.id, undefined, 200);
    assert(json.removedTasks === installedIds.length, 'removedTasks ' + json.removedTasks + ' != ' + installedIds.length);
    await api('GET', base + '/presets/' + created.id, undefined, 404);
    for (const id of installedIds) await api('GET', base + '/' + id, undefined, 404);
    return json.removedTasks + ' installed tasks purged';
  });

  // ── #7 on-disk layout ───────────────────────────────────────────────────────
  let layoutTask = null;
  let layoutRun = null;
  await check('#7a createTask materializes the task workspace on disk', async () => {
    layoutTask = (await api('POST', base, {
      title: 'Layout check',
      prompt: 'LAYOUT_PROMPT',
      projectPath: PROJECT_A,
      rule: { kind: 'interval', everySeconds: 3600 },
    }, 201)).json.task;
    const dir = path.join(DATA_DIR, layoutTask.id);
    assert(dir.startsWith(DATA_DIR), 'task dir outside the configured root');
    assertDir(dir, 'task root');
    assertFile(path.join(dir, 'task.json'), 'task root');
    assertFile(path.join(dir, 'prompt.md'), 'task root');
    assertFile(path.join(dir, 'README.md'), 'task root');
    // §10.4: no state/ or tmp/ is prescribed or created by the framework.
    assert(!fs.existsSync(path.join(dir, 'state')), 'task root must not get a state/ dir');
    assert(!fs.existsSync(path.join(dir, 'tmp')), 'task root must not get a tmp/ dir');
    const snapshot = readJsonFile(path.join(dir, 'task.json'));
    assert(snapshot.schemaVersion === 1, 'task.json schemaVersion: ' + snapshot.schemaVersion);
    assert(snapshot.id === layoutTask.id, 'task.json id mismatch');
    assert(snapshot.projectPath === PROJECT_A, 'task.json projectPath mismatch');
    assert(snapshot.rule && snapshot.rule.kind === 'interval', 'task.json rule mismatch');
    assert(readTextFile(path.join(dir, 'prompt.md')) === 'LAYOUT_PROMPT', 'prompt.md is not the task prompt copy');
    const readme = readTextFile(path.join(dir, 'README.md'));
    assert(readme.indexOf('Scheduled task workspace') >= 0, 'README.md missing the layout heading');
    assert(readme.indexOf('belongs to the task') >= 0, 'README.md missing the per-task-root contract');
    assert(readme.indexOf('task.json, prompt.md and README.md') >= 0, 'README.md missing the framework-file list');
    assert(readme.indexOf('Prefer keeping files the task generates') >= 0, 'README.md missing the write preference');
    return dir;
  });

  await check('#7b a dry run writes the full run layout', async () => {
    assert(layoutTask, 'no layout task (see #7a)');
    const started = (await api('POST', base + '/' + layoutTask.id + '/run', undefined, 202)).json.run;
    assert(started && started.id, 'no run row returned');
    layoutRun = await poll('layout run to finish', async () => {
      const runs = (await api('GET', base + '/' + layoutTask.id + '/runs?limit=5', undefined, 200)).json.runs;
      const found = runs.find((r) => r.id === started.id);
      return found && found.status !== 'running' ? found : null;
    });
    assert(layoutRun.status === 'success', 'run status ' + layoutRun.status + ' err=' + layoutRun.error);
    assert(String(layoutRun.output).indexOf('[dry-run] LAYOUT_PROMPT') === 0, 'dry-run output mismatch: ' + JSON.stringify(layoutRun.output));
    assert(layoutRun.promptUsed === 'LAYOUT_PROMPT', 'prompt_used must stay the pre-block prompt: ' + JSON.stringify(layoutRun.promptUsed));
    const taskDir = path.join(DATA_DIR, layoutTask.id);
    const runDir = path.join(taskDir, 'runs', layoutRun.id);
    assertDir(runDir, 'run');
    assertFile(path.join(runDir, 'run.json'), 'run');
    assertFile(path.join(runDir, 'prompt.md'), 'run');
    assertFile(path.join(runDir, 'output.md'), 'run');
    assertDir(path.join(runDir, 'logs'), 'run');
    assert(!fs.existsSync(path.join(runDir, 'tmp')), 'the framework must not create a per-run tmp/');
    const meta = readJsonFile(path.join(runDir, 'run.json'));
    assert(meta.schemaVersion === 1, 'run.json schemaVersion: ' + meta.schemaVersion);
    assert(meta.runId === layoutRun.id, 'run.json runId mismatch');
    assert(meta.taskId === layoutTask.id, 'run.json taskId mismatch');
    assert(meta.status === 'success', 'run.json status: ' + meta.status);
    assert(meta.workspace && meta.workspace.root === DATA_DIR, 'run.json workspace.root mismatch: ' + JSON.stringify(meta.workspace));
    assert(meta.workspace.taskDir === taskDir, 'run.json workspace.taskDir mismatch');
    assert(meta.workspace.runDir === runDir, 'run.json workspace.runDir mismatch');
    const agentPrompt = readTextFile(path.join(runDir, 'prompt.md'));
    assert(agentPrompt.indexOf('## Scheduled task workspace') === 0, 'runs/<id>/prompt.md is missing the workspace block');
    assert(agentPrompt.indexOf('LAYOUT_PROMPT') > 0, 'runs/<id>/prompt.md is missing the task prompt');
    assert(readTextFile(path.join(runDir, 'output.md')).indexOf('[dry-run]') === 0, 'output.md is not the dry-run output');
    return 'run ' + layoutRun.id + ' + full task/run layout';
  });

  // ── #8 script-gate env ──────────────────────────────────────────────────────
  const Q = String.fromCharCode(39);
  const ENV_PROBE_COMMAND = 'printf ' + Q + '{"prompt":"%s"}' + Q + ' "$SCHEDULED_TASK_DIR|$SCHEDULED_TASK_RUN_ID|$SCHEDULED_TASK_RUN_DIR"';
  await check('#8 the script gate sees the three SCHEDULED_TASK_* workspace vars', async () => {
    const probeTask = (await api('POST', base, {
      title: 'Env probe',
      prompt: 'ENV_PROBE_FALLBACK',
      projectPath: PROJECT_A,
      rule: { kind: 'interval', everySeconds: 3600 },
      command: ENV_PROBE_COMMAND,
    }, 201)).json.task;
    assert(probeTask.command === ENV_PROBE_COMMAND, 'command not stored');
    const started = (await api('POST', base + '/' + probeTask.id + '/run', undefined, 202)).json.run;
    const finished = await poll('env probe run to finish', async () => {
      const runs = (await api('GET', base + '/' + probeTask.id + '/runs?limit=5', undefined, 200)).json.runs;
      const found = runs.find((r) => r.id === started.id);
      return found && found.status !== 'running' ? found : null;
    });
    assert(finished.status === 'success', 'probe run status ' + finished.status + ' err=' + finished.error);
    const prefix = '[dry-run] ';
    assert(String(finished.output).indexOf(prefix) === 0, 'unexpected probe output: ' + JSON.stringify(finished.output));
    const values = String(finished.output).slice(prefix.length).split('|');
    assert(values.length === 3, 'expected 3 env values, got ' + values.length + ': ' + JSON.stringify(values));
    const taskDir = path.join(DATA_DIR, probeTask.id);
    const expected = [taskDir, started.id, path.join(taskDir, 'runs', started.id)];
    for (let i = 0; i < expected.length; i += 1) {
      assert(values[i] === expected[i], 'env var ' + i + ' mismatch: got ' + JSON.stringify(values[i]) + ' want ' + JSON.stringify(expected[i]));
    }
    assert(finished.scriptExitCode === 0, 'scriptExitCode ' + finished.scriptExitCode);
    const gateLog = path.join(taskDir, 'runs', started.id, 'logs', 'gate-stdout.log');
    assertFile(gateLog, 'gate stdout');
    assert(readTextFile(gateLog).indexOf(values[0]) >= 0, 'gate-stdout.log does not contain the gate output');
    return values.join(' | ');
  });

  // ── #9 task workspace purge ─────────────────────────────────────────────────
  await check('#9 DELETE keeps the task workspace by default and ?purge=1 removes it', async () => {
    const keep = (await api('POST', base, {
      title: 'Keep workspace', prompt: 'KEEP', projectPath: PROJECT_A,
      rule: { kind: 'interval', everySeconds: 3600 },
    }, 201)).json.task;
    const keepDir = path.join(DATA_DIR, keep.id);
    assertDir(keepDir, 'task workspace');
    const del = await api('DELETE', base + '/' + keep.id, undefined, 200);
    assert(del.json.deleted === true, 'deleted flag missing');
    assertDir(keepDir, 'workspace after DELETE without purge');
    const drop = (await api('POST', base, {
      title: 'Drop workspace', prompt: 'DROP', projectPath: PROJECT_A,
      rule: { kind: 'interval', everySeconds: 3600 },
    }, 201)).json.task;
    const dropDir = path.join(DATA_DIR, drop.id);
    assertDir(dropDir, 'task workspace');
    await api('DELETE', base + '/' + drop.id + '?purge=1', undefined, 200);
    assert(!fs.existsSync(dropDir), 'workspace should be removed by ?purge=1: ' + dropDir);
    return 'kept by default, removed with purge=1';
  });

  // ── home-dir guard ──────────────────────────────────────────────────────────
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
    console.log('[presets-e2e] ' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const f of failures) console.log('  - ' + f);
      process.exitCode = 1;
    } else {
      console.log('[presets-e2e] OK');
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
