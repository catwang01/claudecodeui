#!/usr/bin/env node
/**
 * Acceptance check for the scheduled-task AGENT TOOLS (lead-owned).
 *
 * Drives the eight SDK tool handlers directly against a real temp SQLite database,
 * and verifies the claude-sdk wiring (tool registration + allowedTools) through the
 * additive test seams. No model call, no server process.
 *
 * Usage (Node 22, and the --tsconfig flag is required for the "@/" aliases):
 *   npx tsx --tsconfig server/tsconfig.json scripts/verify-schedule-tools.mjs
 * Exit code 0 = all checks passed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-tools-'));
const PROJECT = path.join(TMP, 'project');
const OTHER_PROJECT = path.join(TMP, 'other-project');
fs.mkdirSync(PROJECT, { recursive: true });
fs.mkdirSync(OTHER_PROJECT, { recursive: true });

process.env.DATABASE_PATH = path.join(TMP, 'auth.db');
process.env.SCHEDULED_TASKS_ENABLED = '0';
process.env.SCHEDULED_TASK_DRY_RUN = '1';
process.env.SCHEDULED_TASKS_TICK_MS = '1000';

const url = (rel) => new URL('../' + rel, import.meta.url).href;

let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const EXPECTED_TOOLS = [
  'schedule_create',
  'schedule_list',
  'schedule_get',
  'schedule_update',
  'schedule_delete',
  'schedule_run',
  'schedule_pause',
  'schedule_resume',
];

async function main() {
  console.log('[tools-e2e] temp dir: ' + TMP);

  await import(url('server/database/db.js')); // runs migrations on the temp DB
  const { createScheduleTools } = await import(url('server/scheduled-tasks/tools.js'));
  const { scheduledTasksDb } = await import(url('server/modules/database/index.js'));
  const sdk = await import(url('server/claude-sdk.js'));

  const tools = createScheduleTools({ projectPath: PROJECT });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const call = async (name, args) => {
    const def = byName.get(name);
    if (!def) throw new Error('tool not exported: ' + name);
    const res = await def.handler(args, {});
    const text = (res?.content ?? []).map((c) => c.text ?? '').join('');
    try { return JSON.parse(text); } catch { return { __raw: text }; }
  };

  // ── registration + wiring ─────────────────────────────────────────────────
  await check('all eight tools are exported with descriptions and schemas', () => {
    const names = tools.map((t) => t.name).sort();
    assert(JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()), 'unexpected tool set: ' + names.join(','));
    for (const t of tools) {
      assert(typeof t.description === 'string' && t.description.length > 20, t.name + ' has no description');
      assert(t.inputSchema && typeof t.inputSchema === 'object', t.name + ' has no inputSchema');
      assert(typeof t.handler === 'function', t.name + ' has no handler');
    }
    return names.join(', ');
  });

  await check('claude-sdk registers the tools and allowlists them', () => {
    assert(typeof sdk.getInternalToolNames === 'function', 'getInternalToolNames is not exported');
    const names = sdk.getInternalToolNames({ projectPath: PROJECT });
    for (const n of EXPECTED_TOOLS) {
      assert(names.includes(n), 'internal tool list misses ' + n + ' (got ' + names.join(',') + ')');
    }
    assert(typeof sdk.mapCliOptionsToSDK === 'function', 'mapCliOptionsToSDK is not exported');
    const mapped = sdk.mapCliOptionsToSDK({ cwd: PROJECT, permissionMode: 'default' });
    for (const n of EXPECTED_TOOLS) {
      assert(mapped.allowedTools.includes('mcp__internal__' + n), 'allowedTools misses mcp__internal__' + n);
    }
    return EXPECTED_TOOLS.length + ' tools registered + allowlisted';
  });

  await check('the real SDK accepts the tool definitions (createSdkMcpServer)', async () => {
    const { createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
    const server = createSdkMcpServer({ name: 'internal-selftest', version: '1.0.0', tools });
    assert(server && server.type === 'sdk', 'unexpected server config: ' + JSON.stringify(server && server.type));
    assert(server.instance, 'no MCP server instance was created');
    return 'server instance created with ' + tools.length + ' tools';
  });

  await check('every schedule_* description states precedence over built-in Cron tools', () => {
    const missing = tools.filter((t) => !/CronCreate/.test(t.description || '')).map((t) => t.name);
    assert(missing.length === 0, 'descriptions without the precedence note: ' + missing.join(','));
    const create = byName.get('schedule_create');
    assert(/preferred|authoritative|instead of/i.test(create.description), 'schedule_create does not state it is preferred');
    return EXPECTED_TOOLS.length + ' descriptions carry the note';
  });

  await check('built-in Cron tools stay available by default (soft preference)', () => {
    const mapped = sdk.mapCliOptionsToSDK({ cwd: PROJECT, permissionMode: 'default' });
    const blocked = ['CronCreate', 'CronList', 'CronDelete'].filter((n) => mapped.disallowedTools.includes(n));
    assert(blocked.length === 0, 'Cron tools must not be blocked by default: ' + JSON.stringify(mapped.disallowedTools));
    return 'not blocked by default';
  });

  await check('the user deny list passes through untouched', () => {
    const mapped = sdk.mapCliOptionsToSDK({
      cwd: PROJECT,
      permissionMode: 'default',
      toolsSettings: { allowedTools: [], disallowedTools: ['CronCreate', 'SomethingElse'], skipPermissions: false },
    });
    assert(
      JSON.stringify(mapped.disallowedTools) === JSON.stringify(['CronCreate', 'SomethingElse']),
      'deny list was rewritten: ' + JSON.stringify(mapped.disallowedTools)
    );
    return JSON.stringify(mapped.disallowedTools);
  });

  await check('SCHEDULED_TASKS_BLOCK_BUILTIN_CRON=1 blocks them, without duplicating', () => {
    process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON = '1';
    try {
      const mapped = sdk.mapCliOptionsToSDK({
        cwd: PROJECT,
        permissionMode: 'default',
        toolsSettings: { disallowedTools: ['CronCreate'] },
      });
      for (const n of ['CronCreate', 'CronList', 'CronDelete']) {
        assert(mapped.disallowedTools.includes(n), 'opt-in block misses ' + n);
      }
      assert(mapped.disallowedTools.length === 3, 'duplicates: ' + JSON.stringify(mapped.disallowedTools));
      return JSON.stringify(mapped.disallowedTools);
    } finally {
      delete process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON;
    }
  });

  await check('SCHEDULED_TASKS_TOOLS=0 never blocks them', () => {
    process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON = '1';
    process.env.SCHEDULED_TASKS_TOOLS = '0';
    try {
      const mapped = sdk.mapCliOptionsToSDK({ cwd: PROJECT, permissionMode: 'default' });
      assert(!mapped.disallowedTools.some((n) => n.startsWith('Cron')), 'blocked while ours are absent');
      return 'left alone';
    } finally {
      delete process.env.SCHEDULED_TASKS_BLOCK_BUILTIN_CRON;
      process.env.SCHEDULED_TASKS_TOOLS = '1';
    }
  });

  await check('SCHEDULED_TASKS_TOOLS=0 removes the tools from both places', () => {
    process.env.SCHEDULED_TASKS_TOOLS = '0';
    const names = sdk.getInternalToolNames({ projectPath: PROJECT });
    const mapped = sdk.mapCliOptionsToSDK({ cwd: PROJECT, permissionMode: 'default' });
    assert(!names.some((n) => n.startsWith('schedule_')), 'tools still registered when disabled');
    assert(!mapped.allowedTools.some((t) => t.startsWith('mcp__internal__schedule_')), 'tools still allowlisted when disabled');
    process.env.SCHEDULED_TASKS_TOOLS = '1';
    return 'disabled cleanly';
  });

  // ── create: every selector form ───────────────────────────────────────────
  const created = {};
  await check('schedule_create every_seconds -> interval rule', async () => {
    const r = await call('schedule_create', { title: 'Queue check', prompt: 'Check the queue', every_seconds: 300 });
    assert(r.id && r.kind === 'interval', 'unexpected: ' + JSON.stringify(r));
    assert(r.rule.everySeconds === 300, 'interval not stored');
    assert(Date.parse(r.nextRunAt) > Date.now(), 'nextRunAt not in the future');
    assert(r.projectPath === PROJECT, 'default project not applied: ' + r.projectPath);
    created.interval = r.id;
    return r.kind + ' next=' + r.nextRunAt;
  });

  await check('schedule_create after_seconds -> once rule', async () => {
    const r = await call('schedule_create', { title: 'Later', prompt: 'Ping', after_seconds: 120 });
    assert(r.kind === 'once', 'unexpected kind ' + r.kind);
    const delta = Date.parse(r.nextRunAt) - Date.now();
    assert(delta > 100000 && delta < 140000, 'after_seconds not honoured: ' + delta);
    created.once = r.id;
    return 'once in ' + Math.round(delta / 1000) + 's';
  });

  await check('schedule_create at -> once rule', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const r = await call('schedule_create', { title: 'At', prompt: 'Ping', at });
    assert(r.kind === 'once' && r.nextRunAt === at, 'at not honoured: ' + JSON.stringify(r));
    created.at = r.id;
    return r.nextRunAt;
  });

  await check('schedule_create daily', async () => {
    const r = await call('schedule_create', { title: 'Daily', prompt: 'Review', daily: { time: '09:30:00', time_zone: 'Asia/Shanghai' } });
    assert(r.kind === 'daily', 'unexpected kind ' + r.kind);
    assert(r.rule.timeZone === 'Asia/Shanghai', 'timezone lost');
    assert(/^09:30(:00)?$/.test(r.rule.time), 'time lost: ' + r.rule.time);
    created.daily = r.id;
    return r.kind + ' ' + r.rule.time + ' ' + r.rule.timeZone;
  });

  await check('schedule_create weekly', async () => {
    const r = await call('schedule_create', { title: 'Weekly', prompt: 'Review', weekly: { time: '08:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3] } });
    assert(r.kind === 'weekly', 'unexpected kind ' + r.kind);
    assert(JSON.stringify(r.rule.weekdays) === '[1,3]', 'weekdays lost: ' + JSON.stringify(r.rule.weekdays));
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(r.nextRunAt));
    assert(['Mon', 'Wed'].includes(local), 'next run not on a selected weekday: ' + local);
    created.weekly = r.id;
    return r.kind + ' ' + r.rule.weekdays + ' next=' + local;
  });

  await check('schedule_create cron', async () => {
    const r = await call('schedule_create', { title: 'Cron', prompt: 'Deploy', cron: { expression: '*/15 9-17 * * 1-5', time_zone: 'Asia/Shanghai' } });
    assert(r.kind === 'cron', 'unexpected kind ' + r.kind);
    assert(r.rule.expression === '*/15 9-17 * * 1-5', 'expression changed: ' + r.rule.expression);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', minute: '2-digit', hour12: false }).formatToParts(new Date(r.nextRunAt));
    assert(Number(parts.find((p) => p.type === 'minute').value) % 15 === 0, 'minute not on a 15m boundary');
    created.cron = r.id;
    return r.kind + ' ' + r.nextRunAt;
  });

  // ── validation / never throws ─────────────────────────────────────────────
  await check('rejects two selectors and no selector without throwing', async () => {
    const two = await call('schedule_create', { title: 'x', prompt: 'x', every_seconds: 300, after_seconds: 60 });
    assert(two.code, 'expected an error code, got ' + JSON.stringify(two));
    const none = await call('schedule_create', { title: 'x', prompt: 'x' });
    assert(none.code, 'expected an error code, got ' + JSON.stringify(none));
    return two.code + ' / ' + none.code;
  });

  await check('rejects a past at and a bad interval with the documented codes', async () => {
    const past = await call('schedule_create', { title: 'x', prompt: 'x', at: new Date(Date.now() - 60_000).toISOString() });
    assert(past.code === 'invalid_schedule_time', 'expected invalid_schedule_time, got ' + past.code);
    const small = await call('schedule_create', { title: 'x', prompt: 'x', every_seconds: 5 });
    assert(small.code === 'invalid_interval', 'expected invalid_interval, got ' + small.code);
    const tz = await call('schedule_create', { title: 'x', prompt: 'x', daily: { time: '09:00', time_zone: 'Mars/Olympus' } });
    assert(tz.code === 'invalid_time_zone', 'expected invalid_time_zone, got ' + tz.code);
    const cron = await call('schedule_create', { title: 'x', prompt: 'x', cron: { expression: 'nope', time_zone: 'Asia/Shanghai' } });
    assert(cron.code === 'invalid_cron', 'expected invalid_cron, got ' + cron.code);
    const empty = await call('schedule_create', {});
    assert(empty.code, 'expected a code for empty args');
    return [past.code, small.code, tz.code, cron.code].join(', ');
  });

  await check('garbage arguments never throw', async () => {
    for (const [name, args] of [['schedule_get', {}], ['schedule_run', {}], ['schedule_delete', {}], ['schedule_pause', {}], ['schedule_resume', {}], ['schedule_update', {}], ['schedule_list', { include_paused: 'yes' }]]) {
      const r = await call(name, args);
      assert(r && typeof r === 'object', name + ' returned non-object');
    }
    return '7 tools survived garbage input';
  });

  // ── list / get ────────────────────────────────────────────────────────────
  await check('schedule_list returns the project tasks', async () => {
    const r = await call('schedule_list', {});
    assert(Array.isArray(r.tasks), 'no tasks array');
    const ids = r.tasks.map((t) => t.id);
    for (const key of ['interval', 'once', 'at', 'daily', 'weekly', 'cron']) {
      assert(ids.includes(created[key]), 'list misses ' + key);
    }
    return r.tasks.length + ' tasks';
  });

  await check('schedule_get returns the task plus recent runs', async () => {
    const r = await call('schedule_get', { id: created.interval });
    assert(r.task && r.task.id === created.interval, 'task missing');
    assert(Array.isArray(r.recent_runs), 'recent_runs missing');
    const miss = await call('schedule_get', { id: 'nope' });
    assert(miss.code === 'not_found', 'expected not_found, got ' + miss.code);
    return 'recent_runs=' + r.recent_runs.length;
  });

  // ── update ────────────────────────────────────────────────────────────────
  await check('schedule_update changes title, prompt and the rule', async () => {
    const r = await call('schedule_update', { id: created.interval, title: 'Queue check v2', prompt: 'Check again', every_seconds: 900 });
    assert(r.title === 'Queue check v2' && r.prompt === 'Check again', 'text not updated: ' + JSON.stringify(r));
    assert(r.rule.everySeconds === 900, 'rule not updated');
    const keep = await call('schedule_update', { id: created.interval, title: 'Queue check v3' });
    assert(keep.rule.everySeconds === 900, 'omitted rule should be preserved');
    return keep.title + ' every ' + keep.rule.everySeconds + 's';
  });

  // ── pause / resume ────────────────────────────────────────────────────────
  await check('schedule_pause clears nextRunAt and hides the task from the default list', async () => {
    const r = await call('schedule_pause', { id: created.interval });
    assert(r.enabled === false, 'not paused');
    assert(r.nextRunAt === null, 'nextRunAt should be null, got ' + r.nextRunAt);
    const def = await call('schedule_list', {});
    assert(!def.tasks.some((t) => t.id === created.interval), 'paused task still in the default list');
    const all = await call('schedule_list', { include_paused: true });
    assert(all.tasks.some((t) => t.id === created.interval), 'include_paused does not return it');
    return 'paused + filtered + include_paused works';
  });

  await check('schedule_resume recomputes nextRunAt', async () => {
    const r = await call('schedule_resume', { id: created.interval });
    assert(r.enabled === true, 'not resumed');
    assert(r.nextRunAt && Date.parse(r.nextRunAt) > Date.now(), 'nextRunAt not recomputed');
    return r.nextRunAt;
  });

  // ── manual trigger ────────────────────────────────────────────────────────
  await check('schedule_run starts a manual run that reaches a terminal status', async () => {
    const r = await call('schedule_run', { id: created.interval });
    assert(r.run && r.run.status === 'running', 'no running run returned: ' + JSON.stringify(r));
    assert(r.run.trigger === 'manual', 'trigger should be manual');
    const deadline = Date.now() + 20000;
    let final = null;
    while (Date.now() < deadline) {
      const row = scheduledTasksDb.listRuns(created.interval, 5, 0).find((x) => x.id === r.run.id);
      if (row && row.status !== 'running') { final = row; break; }
      await sleep(300);
    }
    assert(final, 'run never finished');
    assert(final.status === 'success', 'run failed: ' + final.error);
    assert(String(final.output || '').includes('[dry-run]'), 'expected dry-run output, got ' + JSON.stringify(final.output));
    return 'run ' + final.status + ' by ' + final.trigger;
  });

  // ── project scoping ───────────────────────────────────────────────────────
  await check("tools cannot see or touch another project's task", async () => {
    const foreign = scheduledTasksDb.createTask({
      title: 'Foreign', prompt: 'nope', projectPath: OTHER_PROJECT, provider: 'claude',
      kind: 'interval', ruleJson: JSON.stringify({ kind: 'interval', everySeconds: 300 }),
      nextRunAt: new Date(Date.now() + 60000).toISOString(), enabled: true,
    });
    const listed = await call('schedule_list', { include_paused: true });
    assert(!listed.tasks.some((t) => t.id === foreign.id), 'foreign task leaked into list');
    for (const name of ['schedule_get', 'schedule_pause', 'schedule_resume', 'schedule_delete', 'schedule_run']) {
      const r = await call(name, { id: foreign.id });
      assert(r.code === 'not_found', name + ' should be not_found, got ' + JSON.stringify(r));
    }
    // schedule_update validates its arguments before the scope lookup, so give it a real change.
    const upd = await call('schedule_update', { id: foreign.id, title: 'hijacked' });
    assert(upd.code === 'not_found', 'schedule_update should be not_found, got ' + JSON.stringify(upd));
    const after = scheduledTasksDb.getTask(foreign.id);
    assert(after && after.title === 'Foreign', 'foreign task was modified: ' + JSON.stringify(after && after.title));
    return 'list + 6 mutating tools scoped, foreign task untouched';
  });

  // ── delete ────────────────────────────────────────────────────────────────
  await check('schedule_delete removes the task', async () => {
    const r = await call('schedule_delete', { id: created.interval });
    assert(r.deleted === true, 'deleted flag missing: ' + JSON.stringify(r));
    const gone = await call('schedule_get', { id: created.interval });
    assert(gone.code === 'not_found', 'task still readable');
    const again = await call('schedule_delete', { id: created.interval });
    assert(again.code === 'not_found', 'second delete should be not_found, got ' + JSON.stringify(again));
    return 'deleted + idempotent miss';
  });
}

main()
  .catch((err) => {
    failures.push('fatal: ' + (err && err.stack ? err.stack : err));
    console.log('\nFATAL: ' + (err && err.message ? err.message : err));
  })
  .finally(() => {
    console.log('\n[tools-e2e] ' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const f of failures) console.log('  - ' + f);
      process.exitCode = 1;
    } else {
      console.log('[tools-e2e] OK');
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
