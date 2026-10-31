#!/usr/bin/env node
/**
 * End-to-end acceptance + adversarial check for parametrized scheduled tasks
 * (docs/scheduled-tasks.md section 12, issue #14). Lead-owned verification script.
 *
 * Boots the real server (tsx) against a throwaway SQLite database, a throwaway
 * SCHEDULED_TASK_DATA_DIR and SCHEDULED_TASK_DRY_RUN=1, then walks the REST
 * surface. Asserts every bullet of section 12.9 and then actively tries to
 * falsify the 12.2 / 12.3 boundary cases:
 *
 *   A. section 12.9
 *      A1 create-with-params round-trips; update replaces / null clears
 *      A2 invalid definitions are rejected (REST returns invalid_input)
 *      A3 a dry run records the resolved values (run row)
 *      A4 the gate sees SCHEDULED_TASK_PARAM_* and SCHEDULED_TASK_PARAMS
 *      A5 a per-run override wins over the default
 *      A6 a run missing a required parameter fails with missing_required_param
 *         and never runs the gate / the agent
 *      A7 a task without parameters exports NO SCHEDULED_TASK_PARAM_* and NO
 *         SCHEDULED_TASK_PARAMS (byte-identical env), before and after a
 *         parameter run
 *      A8 reinstalling a preset preserves the parameter contract
 *   B. adversarial boundary cases
 *      B1 case-insensitive duplicate names / name regex
 *      B2 32 params accepted, 33 rejected
 *      B3 16 KiB cap: the largest fitting definition list is accepted, one byte
 *         more is rejected
 *      B4 uncoercible default at creation / uncoercible override at run time
 *      B5 unknown override key
 *      B6 override precedence (string forms coerced, gate + run row + run.json)
 *      B7 prompt block: present for a parametrized task, absent for a bare one
 *      B8 run.json records params (also on the workspace-less failure path)
 *      B9 preset install-time param overrides (honoured, unknown ignored,
 *         uncoercible rejected, idempotent)
 *      B10 SCHEDULED_TASK_PRESET_DIR: unset => default catalog; set => honoured;
 *          nonexistent => graceful empty (issue #4 comment 2 follow-up)
 *      B11 module-level contracts of server/scheduled-tasks/params.js
 *      B12 agent-env seam: runner hands options.env to the provider and
 *          claude-sdk.js merges it into sdkOptions.env (static wiring check;
 *          runtime behaviour is unit-covered by runner.test.js:635/702)
 *
 * Usage: node scripts/verify-scheduled-task-params.mjs
 *   Needs Node 22 (.nvmrc): better-sqlite3 ships a Node 22 native binding.
 * Exit code 0 = all checks passed; 1 = at least one failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
if (NODE_BIN_DIR) console.log('[params-e2e] using node bin dir: ' + NODE_BIN_DIR + ' (current: ' + process.version + ')');
else if (process.version !== 'v22.17.0') console.warn('[params-e2e] WARNING: no Node 22 bin dir found; better-sqlite3 may fail to load under ' + process.version);

const PORT = Number(process.env.E2E_PORT || 3491);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-params-e2e-'));
const DB_PATH = path.join(TMP, 'auth.db');
const DATA_DIR = path.join(TMP, 'scheduled-task-data');
const PROJECT_A = path.join(TMP, 'project-a');
const PROJECT_B = path.join(TMP, 'project-b');
const PROJECT_C = path.join(TMP, 'project-c');
const USER = { username: 'paramuser', password: 'param-password' };
const LF = String.fromCharCode(10);
const Q = String.fromCharCode(39);

for (const dir of [PROJECT_A, PROJECT_B, PROJECT_C]) fs.mkdirSync(dir, { recursive: true });

let child = null;
let token = null;
let passed = 0;
const failures = [];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function expectJson(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, label + ': got ' + a + ' want ' + e);
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

function readTextFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { throw new Error('cannot read ' + file + ': ' + err.message); }
}

function readJsonFile(file) {
  const text = readTextFile(file);
  try { return JSON.parse(text); } catch (err) { throw new Error('cannot parse JSON ' + file + ': ' + err.message); }
}

function startServer() {
  const env = {
    ...process.env,
    ...(NODE_BIN_DIR ? { PATH: NODE_BIN_DIR + path.delimiter + process.env.PATH } : {}),
    SERVER_PORT: String(PORT),
    VITE_PORT: '5199',
    DATABASE_PATH: DB_PATH,
    SCHEDULED_TASK_DATA_DIR: DATA_DIR,
    SCHEDULED_TASKS_ENABLED: '1',
    SCHEDULED_TASKS_TICK_MS: '1000',
    SCHEDULED_TASK_DRY_RUN: '1',
    NODE_ENV: 'production',
  };
  delete env.SCHEDULED_TASK_PRESET_DIR;
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

function tailLog(lines = 30) {
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

async function poll(label, fn, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error('timed out waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
}

// ── gate probes ───────────────────────────────────────────────────────────────

/** Dump the whole SCHEDULED_TASK* environment to runs/<runId>/env.txt, then a fixed envelope. */
function envDumpCommand() {
  return 'env | grep "^SCHEDULED_TASK" | sort > "$SCHEDULED_TASK_RUN_DIR/env.txt"; printf ' + Q + '{"prompt":"ENVDONE"}' + Q;
}

/** Touch a sentinel in the task tmp dir, proving the gate ran. */
function sentinelCommand(sentinel) {
  return 'env | grep "^SCHEDULED_TASK" | sort > "$SCHEDULED_TASK_RUN_DIR/env.txt"; touch "$SCHEDULED_TASK_TMP_DIR/' + sentinel + '"; printf ' + Q + '{"prompt":"GATE_RAN"}' + Q;
}

function readRunEnv(taskId, runId) {
  return readTextFile(path.join(DATA_DIR, taskId, 'runs', runId, 'env.txt'));
}

function envToMap(text) {
  const map = {};
  for (const line of text.split(LF)) {
    const i = line.indexOf('=');
    if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
  }
  return map;
}

function paramEnvKeys(map) {
  return Object.keys(map)
    .filter((key) => key.startsWith('SCHEDULED_TASK_PARAM_') || key === 'SCHEDULED_TASK_PARAMS')
    .sort();
}

function scheduledKeys(map) {
  return Object.keys(map).filter((key) => key.startsWith('SCHEDULED_TASK')).sort();
}

function parseEnvelopeOutput(output) {
  const prefix = '[dry-run] ';
  assert(typeof output === 'string' && output.indexOf(prefix) === 0, 'unexpected dry-run output: ' + JSON.stringify(output));
  return output.slice(prefix.length);
}

async function createTask(body, expect = 201) {
  const { json } = await api('POST', '/api/scheduled-tasks', {
    title: body.title,
    prompt: body.prompt || 'PARAM_PROMPT',
    projectPath: body.projectPath || PROJECT_A,
    rule: body.rule || { kind: 'interval', everySeconds: 3600 },
    ...(body.command === undefined ? {} : { command: body.command }),
    ...(body.params === undefined ? {} : { params: body.params }),
  }, expect);
  return json ? json.task : null;
}

async function startRun(taskId, body) {
  const { json } = await api('POST', '/api/scheduled-tasks/' + taskId + '/run', body, 202);
  return json.run;
}

async function waitRun(taskId, runId) {
  return poll('run ' + runId, async () => {
    const runs = (await api('GET', '/api/scheduled-tasks/' + taskId + '/runs?limit=20', undefined, 200)).json.runs;
    const found = runs.find((r) => r.id === runId);
    return found && found.status !== 'running' ? found : null;
  });
}

async function runToFinish(taskId, body) {
  const started = await startRun(taskId, body);
  const finished = await waitRun(taskId, started.id);
  return { started, finished };
}

function runJson(taskId, runId) {
  return readJsonFile(path.join(DATA_DIR, taskId, 'runs', runId, 'run.json'));
}

function runPromptMd(taskId, runId) {
  return readTextFile(path.join(DATA_DIR, taskId, 'runs', runId, 'prompt.md'));
}

/** Boot a throwaway server on its own port/DB and list presets (SCHEDULED_TASK_PRESET_DIR checks). */
async function probePresets(presetDir, port) {
  const dbPath = path.join(TMP, 'probe-' + port + '.db');
  const dataDir = path.join(TMP, 'probe-' + port + '-data');
  const logPath = path.join(TMP, 'probe-' + port + '.log');
  const env = {
    ...process.env,
    ...(NODE_BIN_DIR ? { PATH: NODE_BIN_DIR + path.delimiter + process.env.PATH } : {}),
    SERVER_PORT: String(port),
    VITE_PORT: '5200',
    DATABASE_PATH: dbPath,
    SCHEDULED_TASK_DATA_DIR: dataDir,
    SCHEDULED_TASKS_ENABLED: '1',
    SCHEDULED_TASKS_TICK_MS: '1000',
    SCHEDULED_TASK_DRY_RUN: '1',
    NODE_ENV: 'production',
  };
  if (presetDir === null || presetDir === undefined) delete env.SCHEDULED_TASK_PRESET_DIR;
  else env.SCHEDULED_TASK_PRESET_DIR = presetDir;
  const proc = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  proc.stdout.pipe(stream);
  proc.stderr.pipe(stream);
  const origin = 'http://127.0.0.1:' + port;
  const readLog = () => { try { return fs.readFileSync(logPath, 'utf8').split(LF).slice(-25).join(LF); } catch { return '(no log)'; } };
  try {
    const deadline = Date.now() + 90000;
    let healthy = false;
    let lastErr = 'no attempt';
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error('probe server exited ' + proc.exitCode + ': ' + readLog());
      try { const res = await fetch(origin + '/health'); if (res.ok) { healthy = true; break; } lastErr = 'status ' + res.status; } catch (err) { lastErr = err.message; }
      await sleep(300);
    }
    if (!healthy) throw new Error('probe server not healthy (' + lastErr + '): ' + readLog());
    const reg = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'probe' + port, password: 'probe-password' }) });
    const regJson = await reg.json();
    assert(regJson.token, 'probe register failed: ' + JSON.stringify(regJson).slice(0, 200));
    const res = await fetch(origin + '/api/scheduled-tasks/presets', { headers: { Authorization: 'Bearer ' + regJson.token } });
    const json = await res.json();
    return { status: res.status, presets: json.presets || [] };
  } finally {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      for (let i = 0; i < 50 && proc.exitCode === null; i += 1) await sleep(100);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[params-e2e] temp dir: ' + TMP);
  console.log('[params-e2e] data dir: ' + DATA_DIR);
  assert(DATA_DIR.startsWith(TMP), 'data dir must live under the temp dir');

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

  // ── B10a default catalog (SCHEDULED_TASK_PRESET_DIR unset) ──────────────────
  await check('B10a unset SCHEDULED_TASK_PRESET_DIR -> shipped catalog (4 builtins incl. auto-doc)', async () => {
    const { json } = await api('GET', base + '/presets', undefined, 200);
    const ids = json.presets.filter((p) => p.source === 'builtin').map((p) => p.id).sort();
    assert(ids.indexOf('auto-doc') >= 0, 'auto-doc preset missing: ' + JSON.stringify(ids));
    assert(ids.length === 4, 'expected 4 builtins, got ' + JSON.stringify(ids));
    return ids.join(', ');
  });

  // ── A (section 12.9) ────────────────────────────────────────────────────────

  const PARAMS = [
    { name: 'region', type: 'string', default: 'us', description: 'target region' },
    { name: 'threshold', type: 'number', default: 3 },
    { name: 'dryRun', type: 'boolean', default: false },
  ];
  let paramTask = null;

  await check('A1a create-with-params round-trips (normalized ParamDef[])', async () => {
    paramTask = await createTask({ title: 'Param task', params: PARAMS, command: envDumpCommand() });
    expectJson(paramTask.params, [
      { name: 'region', type: 'string', default: 'us', description: 'target region' },
      { name: 'threshold', type: 'number', default: 3 },
      { name: 'dryRun', type: 'boolean', default: false },
    ], 'task.params');
    const fetched = (await api('GET', base + '/' + paramTask.id, undefined, 200)).json.task;
    expectJson(fetched.params, paramTask.params, 'GET task.params');
    return paramTask.id;
  });

  await check('A1b update replaces params and null clears them', async () => {
    const replaced = (await api('PATCH', base + '/' + paramTask.id, {
      params: [{ name: 'repo', type: 'string', default: 'main' }],
    }, 200)).json.task;
    expectJson(replaced.params, [{ name: 'repo', type: 'string', default: 'main' }], 'replaced params');
    const cleared = (await api('PATCH', base + '/' + paramTask.id, { params: null }, 200)).json.task;
    expectJson(cleared.params, [], 'cleared params');
    const restored = (await api('PATCH', base + '/' + paramTask.id, { params: PARAMS }, 200)).json.task;
    expectJson(restored.params, paramTask.params, 'restored params');
    return 'replace + null + restore OK';
  });

  const invalidCases = [
    ['params not an array', { params: { region: 'eu' } }],
    ['name violates the regex', { params: [{ name: '1bad' }] }],
    ['case-insensitive duplicate names', { params: [{ name: 'Region' }, { name: 'region' }] }],
    ['unknown type', { params: [{ name: 'x', type: 'date' }] }],
    ['description > 500 chars', { params: [{ name: 'x', description: 'd'.repeat(501) }] }],
    ['required not boolean', { params: [{ name: 'x', required: 'yes' }] }],
    ['uncoercible default', { params: [{ name: 'n', type: 'number', default: 'abc' }] }],
  ];
  await check('A2 invalid definitions are rejected with invalid_input (7 cases)', async () => {
    for (const [label, body] of invalidCases) {
      const res = await api('POST', base, {
        title: 'bad ' + label,
        prompt: 'x',
        projectPath: PROJECT_A,
        rule: { kind: 'interval', everySeconds: 3600 },
        ...body,
      }, 400);
      assert(res.json && res.json.code === 'invalid_input', label + ': code=' + JSON.stringify(res.json));
    }
    return invalidCases.length + ' rejected';
  });

  await check('A3a a dry run records the resolved values on the run row', async () => {
    const { started, finished } = await runToFinish(paramTask.id);
    assert(finished.status === 'success', 'status ' + finished.status + ' err=' + finished.error);
    assert(parseEnvelopeOutput(finished.output) === 'ENVDONE', 'gate output mismatch');
    expectJson(finished.params, { region: 'us', threshold: 3, dryRun: false }, 'run.params');
    expectJson(started.params, finished.params, 'start payload params');
    return JSON.stringify(finished.params);
  });

  let defaultRunId = null;
  await check('A4 the script gate sees SCHEDULED_TASK_PARAM_* and SCHEDULED_TASK_PARAMS', async () => {
    const runs = (await api('GET', base + '/' + paramTask.id + '/runs?limit=5', undefined, 200)).json.runs;
    defaultRunId = runs[0].id;
    const env = envToMap(readRunEnv(paramTask.id, defaultRunId));
    assert(env.SCHEDULED_TASK_PARAM_REGION === 'us', 'REGION=' + env.SCHEDULED_TASK_PARAM_REGION);
    assert(env.SCHEDULED_TASK_PARAM_THRESHOLD === '3', 'THRESHOLD=' + env.SCHEDULED_TASK_PARAM_THRESHOLD);
    assert(env.SCHEDULED_TASK_PARAM_DRYRUN === 'false', 'DRYRUN=' + env.SCHEDULED_TASK_PARAM_DRYRUN);
    assert(env.SCHEDULED_TASK_PARAMS === '{"region":"us","threshold":3,"dryRun":false}', 'PARAMS=' + env.SCHEDULED_TASK_PARAMS);
    return 'REGION|THRESHOLD|DRYRUN|PARAMS present and exact';
  });

  await check('B7a the Parameters prompt block is prepended (after the workspace block)', async () => {
    const text = runPromptMd(paramTask.id, defaultRunId);
    assert(text.indexOf('## Scheduled task workspace') === 0, 'workspace block must stay first');
    const at = text.indexOf('## Scheduled task parameters');
    assert(at > 0, 'parameters block missing');
    assert(text.indexOf('$SCHEDULED_TASK_PARAM_REGION') > at, 'env var names missing from the block');
    assert(text.indexOf('never hardcode') > at, 'the "never hardcode" wording is missing');
    assert(text.indexOf('ENVDONE') > at, 'effective prompt missing after the blocks');
    const run = (await api('GET', base + '/' + paramTask.id + '/runs?limit=5', undefined, 200)).json.runs[0];
    assert(run.promptUsed === 'ENVDONE', 'prompt_used must stay the pre-block effective prompt: ' + JSON.stringify(run.promptUsed));
    return 'workspace + parameters + prompt, promptUsed unchanged';
  });

  await check('B8 run.json records params', async () => {
    const meta = runJson(paramTask.id, defaultRunId);
    expectJson(meta.params, { region: 'us', threshold: 3, dryRun: false }, 'run.json.params');
    return JSON.stringify(meta.params);
  });

  let overrideRunId = null;
  await check('A5 per-run override wins over the default (gate + run row + run.json)', async () => {
    const { finished } = await runToFinish(paramTask.id, { params: { region: 'eu', threshold: '4', dryRun: true } });
    assert(finished.status === 'success', 'status ' + finished.status + ' err=' + finished.error);
    overrideRunId = finished.id;
    expectJson(finished.params, { region: 'eu', threshold: 4, dryRun: true }, 'run.params');
    const env = envToMap(readRunEnv(paramTask.id, overrideRunId));
    assert(env.SCHEDULED_TASK_PARAM_REGION === 'eu', 'REGION=' + env.SCHEDULED_TASK_PARAM_REGION);
    assert(env.SCHEDULED_TASK_PARAM_THRESHOLD === '4', 'THRESHOLD=' + env.SCHEDULED_TASK_PARAM_THRESHOLD);
    assert(env.SCHEDULED_TASK_PARAM_DRYRUN === 'true', 'DRYRUN=' + env.SCHEDULED_TASK_PARAM_DRYRUN);
    assert(env.SCHEDULED_TASK_PARAMS === '{"region":"eu","threshold":4,"dryRun":true}', 'PARAMS=' + env.SCHEDULED_TASK_PARAMS);
    expectJson(runJson(paramTask.id, overrideRunId).params, { region: 'eu', threshold: 4, dryRun: true }, 'run.json.params');
    return 'override eu/4/true wins';
  });

  // ── A6 missing required parameter ───────────────────────────────────────────
  let requiredTask = null;
  const SENTINEL = 'GATE_RAN';
  await check('A6 required-without-default fails missing_required_param with NO gate and NO agent call', async () => {
    requiredTask = await createTask({
      title: 'Required task',
      prompt: 'REQUIRED_PROMPT',
      params: [{ name: 'token', type: 'string', required: true }],
      command: sentinelCommand(SENTINEL),
    });
    expectJson(requiredTask.params, [{ name: 'token', type: 'string', required: true }], 'required param shape');
    const sentinelPath = path.join(DATA_DIR, requiredTask.id, 'tmp', SENTINEL);
    assert(!fs.existsSync(sentinelPath), 'sentinel must not exist before the run');
    const { finished } = await runToFinish(requiredTask.id);
    assert(finished.status === 'error', 'expected status error, got ' + finished.status + ' output=' + JSON.stringify(finished.output));
    assert(finished.error === 'missing_required_param', 'error=' + JSON.stringify(finished.error));
    assert(finished.sessionId === null, 'no agent session must be created');
    assert(!fs.existsSync(sentinelPath), 'the gate ran even though a required parameter was missing');
    const meta = runJson(requiredTask.id, finished.id);
    assert(meta.status === 'error', 'run.json status=' + meta.status);
    assert(meta.params === undefined || meta.params === null, 'failed run must not record params: ' + JSON.stringify(meta.params));
    return 'error missing_required_param, no gate (sentinel absent), no session';
  });

  await check('A6b supplying the required parameter runs the gate and the agent path', async () => {
    const { finished } = await runToFinish(requiredTask.id, { params: { token: 's3cret' } });
    assert(finished.status === 'success', 'status ' + finished.status + ' err=' + finished.error);
    assert(parseEnvelopeOutput(finished.output) === 'GATE_RAN', 'gate did not run: ' + JSON.stringify(finished.output));
    assert(fs.existsSync(path.join(DATA_DIR, requiredTask.id, 'tmp', SENTINEL)), 'sentinel missing -> gate did not run');
    const env = envToMap(readRunEnv(requiredTask.id, finished.id));
    assert(env.SCHEDULED_TASK_PARAM_TOKEN === 's3cret', 'TOKEN=' + env.SCHEDULED_TASK_PARAM_TOKEN);
    return 'gate ran, TOKEN=s3cret';
  });

  // ── B4/B5 override validation ───────────────────────────────────────────────
  await check('B4 uncoercible per-run override -> 400 invalid_input (no run row)', async () => {
    const before = (await api('GET', base + '/' + paramTask.id + '/runs?limit=50', undefined, 200)).json.runs.length;
    for (const bad of [{ threshold: 'abc' }, { dryRun: 'yes' }]) {
      const res = await api('POST', base + '/' + paramTask.id + '/run', { params: bad }, 400);
      assert(res.json && res.json.code === 'invalid_input', 'code=' + JSON.stringify(res.json));
    }
    await sleep(200);
    const after = (await api('GET', base + '/' + paramTask.id + '/runs?limit=50', undefined, 200)).json.runs.length;
    assert(after === before, 'a rejected override created a run row (' + before + ' -> ' + after + ')');
    return '400 invalid_input, no run row';
  });

  await check('B5 unknown override key -> 400 invalid_input', async () => {
    const res = await api('POST', base + '/' + paramTask.id + '/run', { params: { nope: 'x' } }, 400);
    assert(res.json && res.json.code === 'invalid_input', 'code=' + JSON.stringify(res.json));
    return res.json.message;
  });

  await check('B1 case-insensitive override keys match; an override may set a missing optional value', async () => {
    const { finished } = await runToFinish(paramTask.id, { params: { REGION: 'apac' } });
    assert(finished.status === 'success', 'status ' + finished.status + ' err=' + finished.error);
    expectJson(finished.params, { region: 'apac', threshold: 3, dryRun: false }, 'run.params');
    return 'REGION override applied to region';
  });

  // ── B2 32 vs 33 ─────────────────────────────────────────────────────────────
  await check('B2 32 parameters accepted, 33 rejected', async () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ name: 'p' + i, type: 'string', default: 'v' + i }));
    await createTask({ title: '32 params', params: many(32) });
    const res = await api('POST', base, {
      title: '33 params', prompt: 'x', projectPath: PROJECT_A,
      rule: { kind: 'interval', everySeconds: 3600 }, params: many(33),
    }, 400);
    assert(res.json.code === 'invalid_input', 'code=' + JSON.stringify(res.json));
    return '32 ok, 33 invalid_input';
  });

  // ── B3 16 KiB cap ───────────────────────────────────────────────────────────
  await check('B3 16 KiB JSON cap: largest fitting list accepted, one byte more rejected', async () => {
    const paramsMod = await import(pathToFileURL(path.join(REPO, 'server/scheduled-tasks/params.js')).href);
    const limit = paramsMod.MAX_PARAM_JSON_BYTES;
    assert(limit === 16 * 1024, 'MAX_PARAM_JSON_BYTES=' + limit);
    const defs = (n, l) => Array.from({ length: n }, (_, i) => ({ name: 'p' + i, type: 'string', description: 'd'.repeat(l) }));
    let acceptedLen = null;
    for (let l = 500; l >= 0; l -= 1) {
      const norm = paramsMod.normalizeParamDefs(defs(32, l));
      if (norm.ok && Buffer.byteLength(JSON.stringify(norm.params), 'utf8') <= limit) { acceptedLen = l; break; }
    }
    assert(acceptedLen !== null, 'could not find a definition list under the cap');
    assert(acceptedLen + 1 <= 500, 'boundary description length out of range: ' + acceptedLen);
    const over = paramsMod.normalizeParamDefs(defs(32, acceptedLen + 1));
    assert(!over.ok, 'normalizeParamDefs accepted a list above the 16 KiB cap');
    await createTask({ title: 'at the cap', params: defs(32, acceptedLen) });
    const res = await api('POST', base, {
      title: 'over the cap', prompt: 'x', projectPath: PROJECT_A,
      rule: { kind: 'interval', everySeconds: 3600 }, params: defs(32, acceptedLen + 1),
    }, 400);
    assert(res.json.code === 'invalid_input', 'code=' + JSON.stringify(res.json));
    return 'accepted description length ' + acceptedLen + ' (<= ' + limit + ' bytes), rejected ' + (acceptedLen + 1);
  });

  // ── A7 zero-param byte-identical env (before + after a parameter run) ───────
  let bareTask = null;
  let bareBefore = null;
  await check('A7a zero-param task: gate env has NO SCHEDULED_TASK_PARAM_* / SCHEDULED_TASK_PARAMS', async () => {
    bareTask = await createTask({ title: 'Bare task', command: envDumpCommand() });
    expectJson(bareTask.params, [], 'bare task params');
    const { finished } = await runToFinish(bareTask.id);
    assert(finished.status === 'success', 'status ' + finished.status + ' err=' + finished.error);
    const env = envToMap(readRunEnv(bareTask.id, finished.id));
    const paramKeys = paramEnvKeys(env);
    assert(paramKeys.length === 0, 'zero-param task exported ' + JSON.stringify(paramKeys));
    bareBefore = { keys: scheduledKeys(env), params: paramKeys, runId: finished.id };
    return 'no param vars (' + bareBefore.keys.length + ' SCHEDULED_TASK* vars)';
  });

  await check('B7b zero-param run gets no Parameters block', async () => {
    assert(bareBefore, 'no bare run (see A7a)');
    const text = runPromptMd(bareTask.id, bareBefore.runId);
    assert(text.indexOf('## Scheduled task workspace') === 0, 'workspace block missing');
    assert(text.indexOf('## Scheduled task parameters') < 0, 'zero-param run got a Parameters block');
    const run = (await api('GET', base + '/' + bareTask.id + '/runs?limit=5', undefined, 200)).json.runs[0];
    assert(run.promptUsed === 'ENVDONE', 'promptUsed=' + JSON.stringify(run.promptUsed));
    assert(run.params === null, 'zero-param run.params must be null, got ' + JSON.stringify(run.params));
    return 'no block, promptUsed unchanged, run.params null';
  });

  await check('A7b after a parameter run the zero-param env is still byte-identical', async () => {
    assert(bareBefore, 'no baseline (see A7a)');
    const { finished } = await runToFinish(bareTask.id);
    assert(finished.status === 'success', 'status ' + finished.status + ' err=' + finished.error);
    const env = envToMap(readRunEnv(bareTask.id, finished.id));
    const paramKeys = paramEnvKeys(env);
    assert(paramKeys.length === 0, 'zero-param task exported ' + JSON.stringify(paramKeys));
    expectJson(scheduledKeys(env), bareBefore.keys, 'SCHEDULED_TASK* key set');
    return 'unchanged (' + paramKeys.length + ' param vars before and after)';
  });

  // ── A8 / B9 preset install param overrides ──────────────────────────────────
  await check('A8/B9a custom preset snapshots params; install honours + coerces overrides and ignores unknown names', async () => {
    const source = await createTask({
      title: 'Preset source',
      prompt: 'PRESET_PROMPT',
      params: [{ name: 'region', type: 'string', required: true }, { name: 'count', type: 'number', default: 2 }],
      command: envDumpCommand(),
    });
    const preset = (await api('POST', base + '/presets', {
      name: 'Param bundle', projectPath: PROJECT_A, taskIds: [source.id],
    }, 201)).json.preset;
    const template = preset.tasks[0];
    expectJson(template.params, [{ name: 'region', type: 'string', required: true }, { name: 'count', type: 'number', default: 2 }], 'template.params');

    const installed = (await api('POST', base + '/presets/' + preset.id + '/install', {
      projectPath: PROJECT_B, params: { region: 'eu', NOPE: 'ignored' },
    }, 200)).json;
    assert(installed.created.length === 1, 'created=' + JSON.stringify(installed.created));
    const task = installed.tasks[0];
    expectJson(task.params, [{ name: 'region', type: 'string', default: 'eu' }, { name: 'count', type: 'number', default: 2 }], 'installed params');
    assert(task.params[0].required === undefined, 'required must be dropped once an install override supplies a default');

    // The override really took effect: a run without a per-run override succeeds.
    const { finished } = await runToFinish(task.id);
    assert(finished.status === 'success', 'status ' + finished.status + ' err=' + finished.error);
    expectJson(finished.params, { region: 'eu', count: 2 }, 'installed run.params');
    const env = envToMap(readRunEnv(task.id, finished.id));
    assert(env.SCHEDULED_TASK_PARAM_REGION === 'eu', 'REGION=' + env.SCHEDULED_TASK_PARAM_REGION);
    assert(env.SCHEDULED_TASK_PARAM_COUNT === '2', 'COUNT=' + env.SCHEDULED_TASK_PARAM_COUNT);

    // Idempotent reinstall keeps the contract and does not duplicate the task.
    const again = (await api('POST', base + '/presets/' + preset.id + '/install', {
      projectPath: PROJECT_B, params: { region: 'eu' },
    }, 200)).json;
    assert(again.created.length === 0 && again.updated.length === 1, 'reinstall should update only: ' + JSON.stringify(again));
    expectJson(again.tasks[0].params, task.params, 'reinstalled params');
    return preset.id + ' installed with region=eu, unknown key ignored';
  });

  await check('B9b an uncoercible install override -> 400 invalid_input and no task materialized', async () => {
    const source = await createTask({
      title: 'Bad install source',
      params: [{ name: 'count', type: 'number', default: 1 }],
    });
    const preset = (await api('POST', base + '/presets', {
      name: 'Bad install bundle', projectPath: PROJECT_A, taskIds: [source.id],
    }, 201)).json.preset;
    const res = await api('POST', base + '/presets/' + preset.id + '/install', {
      projectPath: PROJECT_C, params: { count: 'abc' },
    }, 400);
    assert(res.json.code === 'invalid_input', 'code=' + JSON.stringify(res.json));
    const all = (await api('GET', base + '?status=all', undefined, 200)).json.tasks;
    assert(!all.some((t) => t.projectPath === PROJECT_C), 'a task was materialized despite the invalid override');
    return '400 invalid_input, project C untouched';
  });

  // ── B10 SCHEDULED_TASK_PRESET_DIR (issue #4 comment 2 follow-up) ────────────
  await check('B10b SCHEDULED_TASK_PRESET_DIR honours a custom absolute catalog dir', async () => {
    const customDir = path.join(TMP, 'custom-catalog');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'custom-only.json'), JSON.stringify({
      id: 'custom-only',
      name: 'Custom only',
      tasks: [{ id: 'custom-only-task', title: 'Custom only task', prompt: 'x', rule: { kind: 'daily', time: '01:00', timeZone: 'UTC' } }],
    }));
    const probe = await probePresets(customDir, 3501);
    expectJson(probe.presets.map((p) => p.id).sort(), ['custom-only'], 'custom catalog ids');
    assert(probe.presets[0].source === 'builtin', 'catalog preset source=' + probe.presets[0].source);
    assert(probe.presets[0].tasks.length === 1 && probe.presets[0].tasks[0].id === 'custom-only-task', 'custom templates not loaded');
    return 'custom dir served: ' + probe.presets.map((p) => p.id).join(', ');
  });

  await check('B10c a nonexistent SCHEDULED_TASK_PRESET_DIR is graceful (HTTP 200, empty catalog)', async () => {
    const probe = await probePresets(path.join(TMP, 'no-such-catalog-dir'), 3502);
    assert(probe.status === 200, 'status=' + probe.status);
    expectJson(probe.presets, [], 'missing catalog');
    return 'HTTP 200 with presets: []';
  });

  await check('B10d unset SCHEDULED_TASK_PRESET_DIR falls back to the shipped catalog', async () => {
    const probe = await probePresets(null, 3503);
    const ids = probe.presets.filter((p) => p.source === 'builtin').map((p) => p.id).sort();
    assert(ids.indexOf('auto-doc') >= 0, 'auto-doc missing from the default catalog');
    expectJson(ids, ['auto-doc', 'daily-docs-refresh', 'dependency-audit', 'repo-health-check'], 'default catalog ids');
    return ids.join(', ');
  });

  // ── B11 module contracts ────────────────────────────────────────────────────
  await check('B11 params.js module contracts (pure layer)', async () => {
    const mod = await import(pathToFileURL(path.join(REPO, 'server/scheduled-tasks/params.js')).href);
    assert(mod.PARAM_ENV_PREFIX === 'SCHEDULED_TASK_PARAM_', 'PARAM_ENV_PREFIX');
    assert(mod.PARAMS_ENV_NAME === 'SCHEDULED_TASK_PARAMS', 'PARAMS_ENV_NAME');
    assert(mod.MAX_PARAM_COUNT === 32, 'MAX_PARAM_COUNT');
    assert(mod.MAX_PARAM_JSON_BYTES === 16 * 1024, 'MAX_PARAM_JSON_BYTES');
    assert(mod.paramEnv([], {}) === null, 'paramEnv([]) must be null');
    assert(mod.paramEnv(null, undefined) === null, 'paramEnv(null) must be null');
    const defs = [{ name: 'a', type: 'number', default: 1 }, { name: 'b', type: 'boolean', default: true }];
    expectJson(mod.paramEnv(defs, undefined), { SCHEDULED_TASK_PARAM_A: '1', SCHEDULED_TASK_PARAM_B: 'true', SCHEDULED_TASK_PARAMS: '{"a":1,"b":true}' }, 'paramEnv');
    const missing = mod.resolveParams([{ name: 'x', required: true }], {});
    assert(!missing.ok && missing.code === 'missing_required_param', 'missing required code=' + JSON.stringify(missing));
    const unknown = mod.resolveParams(defs, { z: 1 });
    assert(!unknown.ok && unknown.code === 'invalid_input', 'unknown override code=' + JSON.stringify(unknown));
    assert(mod.paramEnvName('dryRun') === 'SCHEDULED_TASK_PARAM_DRYRUN', 'paramEnvName casing');
    return 'prefix/limits/resolution/casing OK';
  });

  // ── B12 agent-env seam (static wiring; runtime unit-covered) ────────────────
  await check('B12 agent-env seam wiring: runner -> options.env -> sdkOptions.env', async () => {
    const runner = readTextFile(path.join(REPO, 'server/scheduled-tasks/runner.js'));
    const sdk = readTextFile(path.join(REPO, 'server/claude-sdk.js'));
    assert(runner.indexOf('options.env = paramVars') >= 0 && runner.indexOf('if (paramVars)') >= 0, 'runner.js no longer sets options.env = paramVars');
    assert(sdk.indexOf('sdkOptions.env = env') >= 0 && sdk.indexOf("options.env") >= 0, 'claude-sdk.js no longer merges options.env into sdkOptions.env');
    assert(runner.indexOf('query(agentPrompt, options, writer)') >= 0, 'runner.js no longer passes options to queryClaudeSDK');
    assert(runner.indexOf('query(agentPrompt, options, writer)') > 0, 'runner.js no longer passes options to queryClaudeSDK');
    return 'static wiring present (runtime asserted by runner.test.js "passes options.env to the agent")';
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
    console.log('[params-e2e] ' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const f of failures) console.log('  - ' + f);
      process.exitCode = 1;
    } else {
      console.log('[params-e2e] OK');
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
