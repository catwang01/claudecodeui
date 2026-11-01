#!/usr/bin/env node
/**
 * Acceptance check for multi-project scheduled tasks and the running-runs list
 * (docs/scheduled-tasks.md section 22).
 *
 * Drives the REAL repository / management / scheduler modules against a real temp
 * SQLite database in SCHEDULED_TASK_DRY_RUN=1 mode, so a due multi-project task
 * fans out one run per project without any model call.
 *
 * Usage (Node 22, --tsconfig is required for the "@/ " aliases):
 *   npx tsx --tsconfig server/tsconfig.json scripts/verify-scheduled-task-multi-project.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-multi-'));
const PROJECT_A = path.join(TMP, 'project-a');
const PROJECT_B = path.join(TMP, 'project-b');
fs.mkdirSync(PROJECT_A, { recursive: true });
fs.mkdirSync(PROJECT_B, { recursive: true });

process.env.DATABASE_PATH = path.join(TMP, 'auth.db');
process.env.SCHEDULED_TASKS_ENABLED = '0';
process.env.SCHEDULED_TASK_DRY_RUN = '1';
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

async function main() {
  console.log('[multi-project] temp dir: ' + TMP);
  await import(url('server/database/db.js'));
  const { scheduledTasksDb: repo } = await import(url('server/modules/database/index.js'));
  const { createManagement } = await import(url('server/scheduled-tasks/management.js'));
  const { createTaskRunner } = await import(url('server/scheduled-tasks/runner.js'));
  const { createScheduler } = await import(url('server/scheduled-tasks/service.js'));

  const mgmt = createManagement({ repo, workspace: null });
  const baseRule = { kind: 'interval', everySeconds: 3600 };

  await check('createTask stores the whole binding and keeps the first as projectPath', async () => {
    const result = await mgmt.createTask({
      title: 'Multi ' + Date.now(),
      prompt: 'do it',
      projectPaths: [PROJECT_A, PROJECT_B],
      rule: baseRule,
    });
    assert(result.ok === true, JSON.stringify(result));
    const task = result.task;
    assert(task.projectPath === PROJECT_A, 'projectPath must be the first project, got ' + task.projectPath);
    assert(
      JSON.stringify(task.projectPaths) === JSON.stringify([PROJECT_A, PROJECT_B]),
      'projectPaths must round-trip, got ' + JSON.stringify(task.projectPaths)
    );
    const row = repo.getTask(task.id);
    assert(row.project_paths_json === JSON.stringify([PROJECT_A, PROJECT_B]), 'project_paths_json not stored');
    return 'projectPath=first, projectPaths=[' + task.projectPaths.length + ']';
  });

  await check('scope: visible from every bound project, not from a third', async () => {
    const created = await mgmt.createTask({
      title: 'Scope',
      prompt: 'p',
      projectPaths: [PROJECT_A, PROJECT_B],
      rule: baseRule,
    });
    const fromB = await mgmt.getTask(created.task.id, { projectPath: PROJECT_B });
    assert(fromB.ok === true, 'expected visible from PROJECT_B: ' + JSON.stringify(fromB));
    const fromC = await mgmt.getTask(created.task.id, { projectPath: path.join(TMP, 'project-c') });
    assert(fromC.ok === false && fromC.code === 'not_found', 'expected not_found from a third project');
    return 'visible from A and B, not C';
  });

  await check('copy / export / import carry the binding', async () => {
    const created = await mgmt.createTask({
      title: 'Portable',
      prompt: 'p',
      projectPaths: [PROJECT_A, PROJECT_B],
      rule: baseRule,
    });
    const copied = await mgmt.copyTask(created.task.id, {});
    assert(
      copied.ok === true && JSON.stringify(copied.task.projectPaths) === JSON.stringify([PROJECT_A, PROJECT_B]),
      'copy lost the binding'
    );
    const exported = await mgmt.exportTask(created.task.id);
    assert(
      JSON.stringify(exported.task.projectPaths) === JSON.stringify([PROJECT_A, PROJECT_B]),
      'export lost the binding'
    );
    const imported = await mgmt.importTask(exported.task);
    assert(
      imported.ok === true && JSON.stringify(imported.task.projectPaths) === JSON.stringify([PROJECT_A, PROJECT_B]),
      'import lost the binding'
    );
    return 'copy/export/import keep 2 projects';
  });

  await check('running list: each run keeps its own project and the task title', async () => {
    const task = repo.createTask({
      title: 'Live',
      prompt: 'p',
      projectPath: PROJECT_A,
      projectPathsJson: JSON.stringify([PROJECT_A, PROJECT_B]),
      kind: 'interval',
      ruleJson: JSON.stringify(baseRule),
      nextRunAt: null,
      enabled: true,
    });
    const a = repo.createRun({ taskId: task.id, status: 'running', trigger: 'manual', projectPath: PROJECT_A });
    const b = repo.createRun({ taskId: task.id, status: 'running', trigger: 'manual', projectPath: PROJECT_B });
    repo.markRunAgentStarted(a.id);
    repo.markRunAgentStarted(b.id);

    const view = await mgmt.listRunningTasks(10);
    assert(view.ok === true && view.count === 2, 'expected count 2, got ' + JSON.stringify(view.count));
    const byProject = new Map(view.runs.map((run) => [run.projectPath, run]));
    assert(byProject.has(PROJECT_A) && byProject.has(PROJECT_B), 'run list must keep both projects');
    assert(byProject.get(PROJECT_A).taskTitle === 'Live', 'taskTitle missing');
    repo.failInterruptedRuns(new Date().toISOString(), 'test_cleanup');
    return '2 running runs, distinct projects';
  });

  await check('a due multi-project task fans out one run per project', async () => {
    const task = repo.createTask({
      title: 'Fan-out',
      prompt: 'p',
      projectPath: PROJECT_A,
      projectPathsJson: JSON.stringify([PROJECT_A, PROJECT_B]),
      kind: 'interval',
      ruleJson: JSON.stringify(baseRule),
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      enabled: true,
    });

    // The early checks keep the default service off; this scheduler is driven
    // explicitly, so it must be enabled for tick() to dispatch.
    delete process.env.SCHEDULED_TASKS_ENABLED;
    const runner = createTaskRunner({ scheduledTasksDb: repo });
    const scheduler = createScheduler({
      repo,
      runner,
      now: () => Date.now(),
      computeNextRun: () => Date.now() + 3600000,
      runRetention: () => 50,
    });

    await scheduler.tick();
    await scheduler.whenIdle();

    const runs = repo.listRuns(task.id, 10, 0);
    assert(runs.length === 2, 'expected 2 runs, got ' + runs.length);
    const projects = runs.map((row) => row.project_path).sort();
    const expected = [PROJECT_A, PROJECT_B].sort();
    assert(JSON.stringify(projects) === JSON.stringify(expected), 'runs must record distinct projects, got ' + JSON.stringify(projects));
    assert(
      runs.every((row) => row.status === 'success'),
      'dry-run fan-out must succeed: ' + JSON.stringify(runs.map((r) => r.status))
    );
    assert(runs.every((row) => row.agent_started_at), 'dry-run marks the agent started (§14.2)');
    return '2 runs, one per project, both success';
  });

  await check('the running list is empty once every run settles', async () => {
    const view = await mgmt.listRunningTasks(10);
    assert(view.ok === true && view.count === 0 && view.runs.length === 0, 'expected empty, got ' + JSON.stringify(view));
    return 'count 0';
  });
}

main()
  .catch((err) => {
    failures.push('fatal: ' + (err && err.stack ? err.stack : err));
    console.log('\nFATAL: ' + (err && err.message ? err.message : err));
  })
  .finally(() => {
    console.log('\n[multi-project] ' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) {
      for (const failure of failures) console.log('  - ' + failure);
      process.exitCode = 1;
    } else {
      console.log('[multi-project] OK');
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
