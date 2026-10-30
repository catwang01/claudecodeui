#!/usr/bin/env node
/**
 * Acceptance check for the script gate (lead-owned) — docs/scheduled-tasks.md §7.
 *
 * Drives the REAL runner (startTaskRun) against a real temp SQLite database with real
 * '/bin/sh' commands and SCHEDULED_TASK_DRY_RUN=1. The dry-run seam covers only the agent
 * call, so the dry-run output reveals the EFFECTIVE prompt and every gate branch can be
 * proven without spending model tokens.
 *
 * Usage (Node 22, --tsconfig is required for the "@/" aliases):
 *   npx tsx --tsconfig server/tsconfig.json scripts/verify-script-gate.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-gate-'));
const PROJECT = path.join(TMP, 'project');
fs.mkdirSync(PROJECT, { recursive: true });

process.env.DATABASE_PATH = path.join(TMP, 'auth.db');
process.env.SCHEDULED_TASKS_ENABLED = '0';
process.env.SCHEDULED_TASK_DRY_RUN = '1';

const url = (rel) => new URL('../' + rel, import.meta.url).href;

let passed = 0;
const failures = [];
const STATIC_PROMPT = 'STATIC PROMPT';

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

const emit = (json) => "echo '" + json + "'";

async function main() {
  console.log('[gate-e2e] temp dir: ' + TMP);
  await import(url('server/database/db.js'));
  const { scheduledTasksDb } = await import(url('server/modules/database/index.js'));
  const { startTaskRun } = await import(url('server/scheduled-tasks/runner.js'));

  let seq = 0;
  async function makeTask(extra = {}) {
    seq += 1;
    return scheduledTasksDb.createTask({
      title: 'Gate ' + seq,
      prompt: STATIC_PROMPT,
      projectPath: PROJECT,
      provider: 'claude',
      kind: 'interval',
      ruleJson: JSON.stringify({ kind: 'interval', everySeconds: 300 }),
      nextRunAt: new Date(Date.now() + 60000).toISOString(),
      enabled: true,
      ...extra,
    });
  }

  async function fire(task) {
    const started = Date.now();
    const { run, done } = startTaskRun(task, { trigger: 'manual' });
    const result = await done;
    const row = scheduledTasksDb.listRuns(task.id, 5, 0).find((r) => r.id === run.id) || run;
    return { result, row, elapsedMs: Date.now() - started };
  }

  const noAgent = (r) => !String(r.output || '').includes('[dry-run]');
  const agentPrompt = (r) => {
    const m = /^\[dry-run\] ([\s\S]*)$/.exec(String(r.output || ''));
    return m ? m[1] : null;
  };

  // ── skip saves the tokens ─────────────────────────────────────────────────
  await check('{"skip":true,"reason":...} -> skipped, no agent call', async () => {
    const task = await makeTask({ command: emit('{"skip":true,"reason":"nothing to do"}') });
    const { result, row } = await fire(task);
    assert(result.status === 'skipped', 'expected skipped, got ' + result.status + ' err=' + result.error);
    assert(noAgent(result), 'agent must not be called on skip');
    assert(String(result.output || '').includes('nothing to do'), 'reason not recorded: ' + result.output);
    assert(row.script_exit_code === 0, 'exit code not stored: ' + row.script_exit_code);
    assert(String(row.script_output || '').includes('"skip"'), 'script stdout not stored');
    assert(!row.prompt_used, 'prompt_used should be empty for a skipped run');
    return 'skipped, reason -> ' + result.output;
  });

  await check('{"skip":true} without reason still skips', async () => {
    const task = await makeTask({ command: emit('{"skip":true}') });
    const { result } = await fire(task);
    assert(result.status === 'skipped', 'expected skipped, got ' + result.status);
    assert(noAgent(result), 'agent must not be called');
    return 'skipped';
  });

  // ── prompt override / fallback ────────────────────────────────────────────
  await check('{"prompt":"DYNAMIC"} overrides the task prompt', async () => {
    const task = await makeTask({ command: emit('{"prompt":"DYNAMIC PROMPT"}') });
    const { result, row } = await fire(task);
    assert(result.status === 'success', 'expected success, got ' + result.status + ' err=' + result.error);
    assert(agentPrompt(result) === 'DYNAMIC PROMPT', 'effective prompt was ' + JSON.stringify(agentPrompt(result)));
    assert(row.prompt_used === 'DYNAMIC PROMPT', 'prompt_used not stored: ' + row.prompt_used);
    return 'prompt -> ' + agentPrompt(result);
  });

  await check('{"skip":false} falls back to the task prompt', async () => {
    const task = await makeTask({ command: emit('{"skip":false}') });
    const { result, row } = await fire(task);
    assert(result.status === 'success', 'expected success, got ' + result.status + ' err=' + result.error);
    assert(agentPrompt(result) === STATIC_PROMPT, 'effective prompt was ' + JSON.stringify(agentPrompt(result)));
    assert(row.prompt_used === STATIC_PROMPT, 'prompt_used not stored');
    return 'fallback -> ' + agentPrompt(result);
  });

  await check('JSON on the last line wins over earlier noise', async () => {
    const task = await makeTask({ command: "echo 'collecting...'; " + emit('{"prompt":"LAST LINE"}') });
    const { result, row } = await fire(task);
    assert(result.status === 'success', 'expected success, got ' + result.status + ' err=' + result.error);
    assert(agentPrompt(result) === 'LAST LINE', 'effective prompt was ' + JSON.stringify(agentPrompt(result)));
    assert(String(row.script_output || '').includes('collecting'), 'raw stdout should be kept');
    return 'noise tolerated';
  });

  await check('script receives SCHEDULED_TASK_* env vars', async () => {
    const task = await makeTask({ command: 'printf \'{"prompt":"id=%s"}\' "$SCHEDULED_TASK_ID"' });
    const { result } = await fire(task);
    assert(result.status === 'success', 'expected success, got ' + result.status + ' err=' + result.error);
    assert(agentPrompt(result) === 'id=' + task.id, 'env var not passed: ' + JSON.stringify(agentPrompt(result)));
    return 'SCHEDULED_TASK_ID=' + task.id;
  });

  // ── fail loud, still no agent call ────────────────────────────────────────
  await check('empty object -> invalid_script_output, no agent call', async () => {
    const task = await makeTask({ command: emit('{}') });
    const { result } = await fire(task);
    assert(result.status === 'error' && result.error === 'invalid_script_output', 'got ' + result.status + '/' + result.error);
    assert(noAgent(result), 'agent must not be called');
    return result.error;
  });

  await check('non-boolean skip -> invalid_script_output', async () => {
    const task = await makeTask({ command: emit('{"skip":"yes"}') });
    const { result } = await fire(task);
    assert(result.error === 'invalid_script_output', 'got ' + result.error);
    return result.error;
  });

  await check('non-JSON stdout -> invalid_script_output', async () => {
    const task = await makeTask({ command: 'echo not json at all' });
    const { result } = await fire(task);
    assert(result.error === 'invalid_script_output', 'got ' + result.error);
    assert(noAgent(result), 'agent must not be called');
    return result.error;
  });

  await check('non-zero exit -> script_exit_3, no agent call', async () => {
    const task = await makeTask({ command: "echo '{\"prompt\":\"should not run\"}'; exit 3" });
    const { result, row } = await fire(task);
    assert(result.status === 'error' && result.error === 'script_exit_3', 'got ' + result.status + '/' + result.error);
    assert(noAgent(result), 'agent must not be called');
    assert(row.script_exit_code === 3, 'exit code not stored: ' + row.script_exit_code);
    return result.error;
  });

  await check('timeout -> script_timeout, killed fast', async () => {
    const task = await makeTask({ command: 'sleep 30', commandTimeoutSeconds: 1 });
    const { result, elapsedMs } = await fire(task);
    assert(result.status === 'error' && result.error === 'script_timeout', 'got ' + result.status + '/' + result.error);
    assert(elapsedMs < 15000, 'took too long: ' + elapsedMs + 'ms');
    assert(noAgent(result), 'agent must not be called');
    return result.error + ' after ' + elapsedMs + 'ms';
  });

  await check('SCHEDULED_TASKS_COMMANDS=0 blocks the script, no agent call', async () => {
    process.env.SCHEDULED_TASKS_COMMANDS = '0';
    try {
      const task = await makeTask({ command: emit('{"prompt":"should not run"}') });
      const { result } = await fire(task);
      assert(result.status === 'error' && result.error === 'commands_disabled', 'got ' + result.status + '/' + result.error);
      assert(noAgent(result), 'agent must not be called');
      return result.error;
    } finally {
      delete process.env.SCHEDULED_TASKS_COMMANDS;
    }
  });

  // ── unchanged paths ───────────────────────────────────────────────────────
  await check('a task without a command behaves exactly as before', async () => {
    const task = await makeTask();
    const { result, row } = await fire(task);
    assert(result.status === 'success', 'expected success, got ' + result.status + ' err=' + result.error);
    assert(agentPrompt(result) === STATIC_PROMPT, 'prompt changed: ' + JSON.stringify(agentPrompt(result)));
    assert(!row.script_output, 'script_output should stay empty');
    return 'no-gate path intact';
  });
}

main()
  .catch((err) => {
    failures.push('fatal: ' + (err && err.stack ? err.stack : err));
    console.log('\nFATAL: ' + (err && err.message ? err.message : err));
  })
  .finally(() => {
    console.log('\n[gate-e2e] ' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const f of failures) console.log('  - ' + f);
      process.exitCode = 1;
    } else {
      console.log('[gate-e2e] OK');
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
