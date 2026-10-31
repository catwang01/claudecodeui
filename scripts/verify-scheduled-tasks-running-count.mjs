#!/usr/bin/env node
/**
 * Acceptance check for the "running count: only a started agent counts" contract
 * (docs/scheduled-tasks.md §14, acceptance list §14.6).
 *
 * Drives the REAL repository / runner / management modules against a real temp
 * SQLite database. SCHEDULED_TASK_DRY_RUN is deliberately UNSET so the runner takes
 * the real agent path, with only queryClaudeSDK replaced by a deferred fake that
 * blocks until this script releases it. No HTTP server is started.
 *
 * Usage (Node 22, --tsconfig is required for the "@/" aliases):
 *   npx tsx --tsconfig server/tsconfig.json scripts/verify-scheduled-tasks-running-count.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-running-'));
const PROJECT = path.join(TMP, 'project');
fs.mkdirSync(PROJECT, { recursive: true });

process.env.DATABASE_PATH = path.join(TMP, 'auth.db');
process.env.SCHEDULED_TASKS_ENABLED = '0';
// The real agent path is required: the dry-run branch fakes the started mark too.
delete process.env.SCHEDULED_TASK_DRY_RUN;
delete process.env.SCHEDULED_TASKS_COMMANDS;
// §10.4 workspace: never write into the developer's home directory.
process.env.SCHEDULED_TASK_DATA_DIR = path.join(TMP, 'data');

const url = (rel) => new URL('../' + rel, import.meta.url).href;

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
    failures.push(name + ': ' + (err && err.message ? err.message : err));
    console.log('  FAIL  ' + name + '  -> ' + (err && err.message ? err.message : err));
  }
}

/** JSON envelope on stdout, §7 gate protocol. */
const emit = (json) => "echo '" + JSON.stringify(json) + "'";

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + label);
    await sleep(25);
  }
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  console.log('[running-count] temp dir: ' + TMP);
  await import(url('server/database/db.js'));
  const { scheduledTasksDb: repo } = await import(url('server/modules/database/index.js'));
  const { createTaskRunner } = await import(url('server/scheduled-tasks/runner.js'));
  const { createManagement } = await import(url('server/scheduled-tasks/management.js'));

  // The REST layer's own view (§14.3): the same module GET /running uses.
  const mgmt = createManagement({ repo, workspace: null });

  const listRuns = (taskId) => repo.listRuns(taskId, 100, 0);
  const findRun = (taskId, runId) => listRuns(taskId).find((row) => row.id === runId);
  const mustRun = (taskId, runId) => {
    const row = findRun(taskId, runId);
    if (!row) throw new Error('run row not found: ' + runId);
    return row;
  };
  const agentStartedAt = (row) => (row ? row.agent_started_at : undefined);
  const viewRun = (row) => mgmt.runView(row);

  function repoCount() {
    if (typeof repo.countRunningAgentRuns !== 'function') {
      throw new Error('repo.countRunningAgentRuns() is missing (§14.1)');
    }
    return repo.countRunningAgentRuns();
  }

  /** management view count, cross-checked against the repository method. */
  async function runningCount() {
    if (typeof mgmt.countRunningTasks !== 'function') {
      throw new Error('management.countRunningTasks() is missing (§14.3)');
    }
    const view = await mgmt.countRunningTasks();
    assert(
      view && view.ok === true && typeof view.count === 'number',
      'countRunningTasks() -> ' + JSON.stringify(view)
    );
    const direct = repoCount();
    assert(direct === view.count, 'management count ' + view.count + ' != repo count ' + direct);
    return view.count;
  }

  let seq = 0;
  async function makeTask(extra = {}) {
    seq += 1;
    return repo.createTask({
      title: 'Running ' + seq,
      prompt: 'static prompt',
      projectPath: PROJECT,
      provider: 'claude',
      kind: 'interval',
      ruleJson: JSON.stringify({ kind: 'interval', everySeconds: 300 }),
      nextRunAt: new Date(Date.now() + 60000).toISOString(),
      enabled: true,
      ...extra,
    });
  }

  function runnerFor(queryImpl) {
    return createTaskRunner({
      scheduledTasksDb: repo,
      queryClaudeSDK: queryImpl,
      abortClaudeSDKSession: async () => true,
    });
  }

  // ── §14.6 bullet 1: the gate is running, the agent is not ──────────────────
  await check('gate sleeping: count 0 while the script runs (script running != agent running)', async () => {
    const marker = path.join(TMP, 'gate-sleeping.marker');
    const task = await makeTask({
      command: 'touch ' + JSON.stringify(marker) + '; sleep 2; ' + emit({ prompt: 'after sleep' }),
    });
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runner = runnerFor(() => {
      calls += 1;
      return blocked;
    });
    const { run, done } = runner.startTaskRun(task, { trigger: 'manual' });
    let released = false;
    const letGo = () => {
      if (!released) {
        released = true;
        release();
      }
    };
    try {
      await waitFor(() => fs.existsSync(marker), 6000, 'the gate script to start sleeping');
      const row = mustRun(task.id, run.id);
      assert(row.status === 'running', 'run status should be running, got ' + row.status);
      const during = await runningCount();
      assert(during === 0, 'count must be 0 while the gate runs, got ' + during);
      assert(
        agentStartedAt(row) === null,
        'agent_started_at must be NULL while the gate runs, got ' + JSON.stringify(agentStartedAt(row))
      );
      assert(calls === 0, 'the agent must not be called before the gate passes');
    } catch (err) {
      letGo();
      // Let the leaked run finish before the temp dir is removed.
      await withTimeout(done, 10000, 'the gated run to finish').catch(() => {});
      throw err;
    }
    letGo();
    const result = await withTimeout(done, 10000, 'the gated run to finish');
    assert(result.status === 'success', 'expected success, got ' + result.status + ' err=' + result.error);
    assert(
      agentStartedAt(mustRun(task.id, run.id)) !== null,
      'agent_started_at should be set once the agent actually started'
    );
    assert((await runningCount()) === 0, 'count must return to 0 after the run finishes');
    return 'count 0 during the gate; agent_started_at set only after it passed';
  });

  // ── §14.6 bullet 2: a skipped run never counts, never marks ────────────────
  await check('gate skip: count 0 the whole time and agent_started_at never set', async () => {
    const task = await makeTask({ command: 'sleep 2; ' + emit({ skip: true, reason: 'nothing to do' }) });
    let called = 0;
    const runner = runnerFor(() => {
      called += 1;
      return Promise.resolve();
    });
    const { run, done } = runner.startTaskRun(task, { trigger: 'manual' });
    let finished = false;
    const doneP = done.then((value) => {
      finished = true;
      return value;
    });
    let samples = 0;
    const badCounts = [];
    const badMarks = [];
    const deadline = Date.now() + 10000;
    while (!finished && Date.now() < deadline) {
      samples += 1;
      const count = await runningCount();
      if (count !== 0) badCounts.push(count);
      const mark = agentStartedAt(mustRun(task.id, run.id));
      if (mark !== null) badMarks.push(mark);
      await sleep(100);
    }
    const result = await withTimeout(doneP, 10000, 'the skipped run to finish');
    assert(samples >= 3, 'expected to sample the run repeatedly, got ' + samples);
    assert(badCounts.length === 0, 'count was non-zero during the skip gate: ' + JSON.stringify(badCounts));
    assert(badMarks.length === 0, 'agent_started_at was set on a skipped run: ' + JSON.stringify(badMarks));
    assert(result.status === 'skipped', 'expected skipped, got ' + result.status + ' err=' + result.error);
    assert(called === 0, 'queryClaudeSDK must never be called for a skipped run');
    assert(
      agentStartedAt(mustRun(task.id, run.id)) === null,
      'agent_started_at must stay NULL after skipping, got ' +
        JSON.stringify(agentStartedAt(mustRun(task.id, run.id)))
    );
    return samples + ' samples: all count 0, agent_started_at NULL, status skipped';
  });

  // ── §14.6 bullet 3: a started agent counts until it finishes ───────────────
  await check('started agent: count 1 while the fake query is blocked, 0 after it resolves', async () => {
    const task = await makeTask({ command: emit({ prompt: 'started run' }) });
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runner = runnerFor(() => {
      calls += 1;
      return blocked;
    });
    const { run, done } = runner.startTaskRun(task, { trigger: 'manual' });
    let released = false;
    const letGo = () => {
      if (!released) {
        released = true;
        release();
      }
    };
    try {
      await waitFor(() => calls > 0, 8000, 'queryClaudeSDK to be called');
      const row = mustRun(task.id, run.id);
      assert(row.status === 'running', 'run status should be running, got ' + row.status);
      const during = await runningCount();
      assert(during === 1, 'count must be 1 while the agent is blocked, got ' + during);
      const started = agentStartedAt(row);
      assert(
        typeof started === 'string' && started.length > 0,
        'agent_started_at must be a non-empty timestamp while the agent runs, got ' + JSON.stringify(started)
      );
      const view = viewRun(row);
      assert(
        view && view.agentStartedAt === started,
        'run JSON agentStartedAt must mirror agent_started_at, got ' + JSON.stringify(view && view.agentStartedAt)
      );
    } catch (err) {
      letGo();
      // Let the leaked run finish before the temp dir is removed.
      await withTimeout(done, 10000, 'the started run to finish').catch(() => {});
      throw err;
    }
    letGo();
    const result = await withTimeout(done, 10000, 'the started run to finish');
    assert(result.status === 'success', 'expected success, got ' + result.status + ' err=' + result.error);
    const after = mustRun(task.id, run.id);
    assert(
      typeof agentStartedAt(after) === 'string' && agentStartedAt(after).length > 0,
      'agent_started_at must persist after the run finishes, got ' + JSON.stringify(agentStartedAt(after))
    );
    assert((await runningCount()) === 0, 'count must return to 0 after the agent finishes');
    return 'count 1 while blocked, 0 after release';
  });

  // ── §14.6 bullet 4: crash consistency ─────────────────────────────────────
  await check('failInterruptedRuns flips leftover running rows and the count returns to 0', async () => {
    const staleTask = await makeTask();
    const stale = repo.createRun({
      taskId: staleTask.id,
      status: 'running',
      trigger: 'manual',
      startedAt: new Date().toISOString(),
    });
    repo.markRunAgentStarted(stale.id);
    assert(
      agentStartedAt(mustRun(staleTask.id, stale.id)) !== null,
      'markRunAgentStarted must set agent_started_at (§14.1)'
    );

    // A finished row must survive failInterruptedRuns untouched.
    const doneTask = await makeTask();
    const completed = repo.createRun({
      taskId: doneTask.id,
      status: 'success',
      trigger: 'manual',
      startedAt: new Date().toISOString(),
    });
    repo.finishRun(completed.id, { status: 'success', finishedAt: new Date().toISOString(), output: 'ok' });

    assert((await runningCount()) === 1, 'the stale marked running row must be counted before the sweep');
    const finishedAt = new Date().toISOString();
    const changes = repo.failInterruptedRuns(finishedAt, 'server_restart');
    assert(
      typeof changes === 'number' && changes >= 1,
      'failInterruptedRuns should report the affected rows, got ' + JSON.stringify(changes)
    );

    const after = mustRun(staleTask.id, stale.id);
    assert(after.status === 'error', 'leftover running row should become error, got ' + after.status);
    assert(after.error === 'server_restart', 'leftover row should record the reason, got ' + after.error);
    assert(after.finished_at === finishedAt, 'leftover row should record finishedAt, got ' + after.finished_at);
    assert(
      agentStartedAt(after) === null || typeof agentStartedAt(after) === 'string',
      'agent_started_at is unrelated to the sweep'
    );
    assert(
      mustRun(doneTask.id, completed.id).status === 'success',
      'failInterruptedRuns must not touch finished rows'
    );
    assert((await runningCount()) === 0, 'count must return to 0 after the sweep');
    const again = repo.failInterruptedRuns(new Date().toISOString(), 'server_restart');
    assert(again === 0, 'a second failInterruptedRuns should affect nothing, got ' + again);
    return 'running -> error/server_restart, count 1 -> 0, second sweep 0';
  });

  // ── Adversarial: the SQL really counts tasks, not runs ────────────────────
  await check('count is per task (COUNT(DISTINCT task_id)): two running runs of one task count once', async () => {
    const task = await makeTask();
    const first = repo.createRun({ taskId: task.id, status: 'running', trigger: 'manual', startedAt: new Date().toISOString() });
    const second = repo.createRun({ taskId: task.id, status: 'running', trigger: 'manual', startedAt: new Date().toISOString() });
    repo.markRunAgentStarted(first.id);
    repo.markRunAgentStarted(second.id);
    assert((await runningCount()) === 1, 'two running runs of one task must count as 1');
    repo.failInterruptedRuns(new Date().toISOString(), 'test_cleanup');
    assert((await runningCount()) === 0, 'cleanup failed to clear the count');
    return 'two runs -> 1';
  });

  // ── Adversarial: the timestamp is write-once ──────────────────────────────
  await check('markRunAgentStarted is idempotent and never overwrites the first timestamp', async () => {
    const task = await makeTask();
    const run = repo.createRun({ taskId: task.id, status: 'running', trigger: 'manual', startedAt: new Date().toISOString() });
    repo.markRunAgentStarted(run.id);
    const first = agentStartedAt(mustRun(task.id, run.id));
    assert(typeof first === 'string' && first.length > 0, 'the first mark must set agent_started_at, got ' + JSON.stringify(first));
    await sleep(5);
    repo.markRunAgentStarted(run.id);
    const second = agentStartedAt(mustRun(task.id, run.id));
    assert(second === first, 'the second mark overwrote ' + first + ' with ' + second);
    repo.failInterruptedRuns(new Date().toISOString(), 'test_cleanup');
    return 'kept ' + first;
  });

  // ── Adversarial: no non-agent path may mark the run ───────────────────────
  await check('skip/error paths never write agent_started_at (§14.1/§14.2)', async () => {
    const cases = [
      {
        label: 'gate error (exit 3)',
        extra: { command: emit({ prompt: 'should not run' }) + '; exit 3' },
        status: 'error',
        error: 'script_exit_3',
      },
      {
        label: 'invalid gate output',
        extra: { command: 'echo not json at all' },
        status: 'error',
        error: 'invalid_script_output',
      },
      {
        label: 'unsupported provider',
        extra: { command: emit({ prompt: 'should not run' }), provider: 'gemini' },
        status: 'error',
      },
      {
        label: 'missing required parameter',
        extra: { paramsJson: JSON.stringify([{ name: 'region', type: 'string', required: true }]) },
        status: 'error',
        error: 'missing_required_param',
      },
    ];
    let called = 0;
    const runner = runnerFor(() => {
      called += 1;
      return Promise.resolve();
    });
    for (const testCase of cases) {
      const task = await makeTask(testCase.extra);
      const { run, done } = runner.startTaskRun(task, { trigger: 'manual' });
      const result = await withTimeout(done, 10000, testCase.label);
      assert(
        result.status === testCase.status,
        testCase.label + ': expected ' + testCase.status + ', got ' + result.status + ' err=' + result.error
      );
      if (testCase.error) {
        assert(
          result.error === testCase.error,
          testCase.label + ': expected error ' + testCase.error + ', got ' + result.error
        );
      }
      const mark = agentStartedAt(mustRun(task.id, run.id));
      assert(mark === null, testCase.label + ': agent_started_at must stay NULL, got ' + JSON.stringify(mark));
      assert((await runningCount()) === 0, testCase.label + ': count must stay 0');
    }

    process.env.SCHEDULED_TASKS_COMMANDS = '0';
    try {
      const task = await makeTask({ command: emit({ prompt: 'should not run' }) });
      const { run, done } = runner.startTaskRun(task, { trigger: 'manual' });
      const result = await withTimeout(done, 10000, 'commands_disabled');
      assert(
        result.status === 'error' && result.error === 'commands_disabled',
        'commands_disabled: got ' + result.status + ' err=' + result.error
      );
      const mark = agentStartedAt(mustRun(task.id, run.id));
      assert(mark === null, 'commands_disabled: agent_started_at must stay NULL, got ' + JSON.stringify(mark));
      assert((await runningCount()) === 0, 'commands_disabled: count must stay 0');
    } finally {
      delete process.env.SCHEDULED_TASKS_COMMANDS;
    }

    assert(called === 0, 'queryClaudeSDK must not be called on any error path, called ' + called + ' times');
    return cases.length + 1 + ' no-agent paths stayed NULL and counted 0';
  });
}

main()
  .catch((err) => {
    failures.push('fatal: ' + (err && err.stack ? err.stack : err));
    console.log('\nFATAL: ' + (err && err.message ? err.message : err));
  })
  .finally(() => {
    console.log('\n[running-count] ' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const failure of failures) console.log('  - ' + failure);
      process.exitCode = 1;
    } else {
      console.log('[running-count] OK');
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
