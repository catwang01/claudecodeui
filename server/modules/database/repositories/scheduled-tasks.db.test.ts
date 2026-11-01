// @vitest-environment node
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { scheduledTasksDb } from './scheduled-tasks.db.js';

// The connection module resolves DATABASE_PATH lazily (on the first getConnection
// call), so assigning it here - before beforeAll() runs the migrations - is safe.
const databasePath = path.join(os.tmpdir(), 'cloudcli-scheduled-tasks-' + crypto.randomUUID() + '.db');
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = databasePath;

const must = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected a row but found none');
  return value;
};

const tag = (): string => crypto.randomUUID().slice(0, 8);

type TaskInput = Parameters<typeof scheduledTasksDb.createTask>[0];

const makeTask = (overrides: Partial<TaskInput> & Pick<TaskInput, 'title'>) =>
  scheduledTasksDb.createTask({
    prompt: 'prompt',
    projectPath: '/srv/tasks',
    kind: 'daily',
    ruleJson: '{}',
    nextRunAt: null,
    ...overrides,
  });

// The pre-script-gate shape of the two tables (docs section 3): no command /
// command_timeout_seconds / script_* columns. Creating this first exercises the
// addColumnIfMissing upgrade path on a database that already holds rows.
const LEGACY_TASKS_DDL =
  'CREATE TABLE scheduled_tasks (' +
  ' id TEXT PRIMARY KEY, user_id INTEGER, title TEXT NOT NULL, prompt TEXT NOT NULL,' +
  ' project_path TEXT NOT NULL, provider TEXT NOT NULL DEFAULT ' + "'claude'" + ',' +
  ' model TEXT, kind TEXT NOT NULL, rule_json TEXT NOT NULL, next_run_at TEXT,' +
  ' last_run_at TEXT, last_status TEXT, last_error TEXT, enabled INTEGER NOT NULL DEFAULT 1,' +
  ' run_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)';

const LEGACY_RUNS_DDL =
  'CREATE TABLE scheduled_task_runs (' +
  ' id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,' +
  ' status TEXT NOT NULL, "trigger" TEXT NOT NULL, scheduled_for TEXT, started_at TEXT NOT NULL,' +
  ' finished_at TEXT, session_id TEXT, output TEXT, error TEXT)';

const legacyTaskId = crypto.randomUUID();

beforeAll(async () => {
  // Pre-create an empty database file so the connection module does not copy the
  // real legacy auth.db into the temp location.
  await fs.writeFile(databasePath, '');
  const db = getConnection();
  db.exec(LEGACY_TASKS_DDL);
  db.exec(LEGACY_RUNS_DDL);
  db.prepare(
    'INSERT INTO scheduled_tasks (id, user_id, title, prompt, project_path, provider, model, kind, rule_json, ' +
      'next_run_at, last_run_at, last_status, last_error, enabled, run_count, created_at, updated_at) ' +
      'VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, 1, 0, ?, ?)'
  ).run(
    legacyTaskId,
    'Legacy gated task',
    'legacy prompt',
    '/srv/legacy',
    'claude',
    'daily',
    '{}',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
  // runMigrations() runs on every server start: it must add the script-gate columns
  // to the legacy schema above and stay idempotent when run again.
  runMigrations();
  runMigrations();
});

afterAll(async () => {
  closeConnection();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.unlink(databasePath + suffix).catch(() => {});
  }
});

describe('scheduledTasksDb', () => {
  it('creates a task with defaults and reads it back', () => {
    const created = scheduledTasksDb.createTask({
      title: 'Nightly build',
      prompt: 'Run the build',
      projectPath: '/srv/alpha',
      kind: 'interval',
      ruleJson: '{"kind":"interval","everySeconds":300}',
      nextRunAt: '2026-01-01T00:00:00.000Z',
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.user_id).toBeNull();
    expect(created.provider).toBe('claude');
    expect(created.model).toBeNull();
    expect(created.enabled).toBe(1);
    expect(created.run_count).toBe(0);
    expect(created.next_run_at).toBe('2026-01-01T00:00:00.000Z');
    expect(created.last_run_at).toBeNull();
    expect(created.last_status).toBeNull();
    expect(created.last_error).toBeNull();
    expect(created.command).toBeNull();
    expect(created.command_timeout_seconds).toBeNull();
    expect(created.created_at).toBe(created.updated_at);
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const fetched = must(scheduledTasksDb.getTask(created.id));
    expect(fetched.title).toBe('Nightly build');
    expect(fetched.kind).toBe('interval');
    expect(fetched.rule_json).toBe('{"kind":"interval","everySeconds":300}');
    expect(scheduledTasksDb.getTask(crypto.randomUUID())).toBeUndefined();
  });
  it('stores and updates the conflict policy; legacy rows read skip', () => {
    const created = makeTask({ title: 'Policy task', conflictPolicy: 'queue' });
    expect(created.conflict_policy).toBe('queue');

    const plain = makeTask({ title: 'Default policy' });
    expect(plain.conflict_policy).toBe('skip');

    const updated = must(scheduledTasksDb.updateTask(created.id, { conflictPolicy: 'replace' }));
    expect(updated.conflict_policy).toBe('replace');

    // The legacy row predates the column; the migration default makes it 'skip'.
    expect(must(scheduledTasksDb.getTask(legacyTaskId)).conflict_policy).toBe('skip');
  });
  it('stores and clears tags; legacy rows read NULL', () => {
    const created = makeTask({ title: 'Tagged', tagsJson: JSON.stringify(['ops', 'docs']) });
    expect(created.tags_json).toBe('["ops","docs"]');

    const plain = makeTask({ title: 'Untagged' });
    expect(plain.tags_json).toBeNull();

    const updated = must(scheduledTasksDb.updateTask(created.id, { tagsJson: null }));
    expect(updated.tags_json).toBeNull();

    expect(must(scheduledTasksDb.getTask(legacyTaskId)).tags_json).toBeNull();
  });

  it('honours explicit id, user, provider, model, enabled and null next run', () => {
    const id = crypto.randomUUID();
    const created = scheduledTasksDb.createTask({
      id,
      userId: 7,
      title: 'Paused job',
      prompt: 'p',
      projectPath: '/srv/beta',
      provider: 'cursor',
      model: 'gpt',
      kind: 'once',
      ruleJson: '{}',
      nextRunAt: null,
      enabled: false,
      command: 'node gate.js',
      commandTimeoutSeconds: 30,
    });

    expect(created.id).toBe(id);
    expect(created.user_id).toBe(7);
    expect(created.provider).toBe('cursor');
    expect(created.model).toBe('gpt');
    expect(created.enabled).toBe(0);
    expect(created.next_run_at).toBeNull();
    expect(created.command).toBe('node gate.js');
    expect(created.command_timeout_seconds).toBe(30);
  });

  it('lists tasks with status, user and search filters in created_at DESC order', () => {
    const id = tag();
    makeTask({ title: 'Alpha ' + id, prompt: 'nightly ' + id, projectPath: '/srv/alpha-' + id, userId: 1 });
    makeTask({ title: 'Beta ' + id, prompt: 'weekly ' + id, projectPath: '/srv/beta-' + id, userId: 1, enabled: false });
    makeTask({ title: 'Gamma ' + id, prompt: 'monthly ' + id, projectPath: '/srv/gamma-' + id, userId: 2 });

    expect(scheduledTasksDb.listTasks({ search: id })).toHaveLength(3);
    expect(scheduledTasksDb.listTasks({ search: id }).map((row) => row.title)).toEqual([
      'Gamma ' + id,
      'Beta ' + id,
      'Alpha ' + id,
    ]);
    expect(scheduledTasksDb.listTasks({ search: id, userId: 2 }).map((row) => row.title)).toEqual(['Gamma ' + id]);
    expect(scheduledTasksDb.listTasks({ search: id, userId: null })).toHaveLength(3);
    expect(scheduledTasksDb.listTasks({ search: id, status: 'paused' }).map((row) => row.title)).toEqual(['Beta ' + id]);
    expect(scheduledTasksDb.listTasks({ search: id, status: 'active' })).toHaveLength(2);
    expect(scheduledTasksDb.listTasks({ search: id, status: 'all' })).toHaveLength(3);
    expect(scheduledTasksDb.listTasks({ search: 'weekly ' + id })).toHaveLength(1);
    expect(scheduledTasksDb.listTasks({ search: 'gamma-' + id })).toHaveLength(1);
    expect(scheduledTasksDb.listTasks({ search: 'ALPHA ' + id })).toHaveLength(1);
    expect(scheduledTasksDb.listTasks({ search: 'no-such-term-' + id })).toHaveLength(0);
  });

  it('keeps unowned tasks visible to any signed-in user', () => {
    const id = tag();
    makeTask({ title: 'Unowned ' + id, userId: null });
    makeTask({ title: 'Mine ' + id, userId: 1 });
    makeTask({ title: 'Theirs ' + id, userId: 2 });

    const forOne = scheduledTasksDb.listTasks({ search: id, userId: 1 }).map((row) => row.title);
    expect(forOne).toContain('Unowned ' + id);
    expect(forOne).toContain('Mine ' + id);
    expect(forOne).not.toContain('Theirs ' + id);

    const forTwo = scheduledTasksDb.listTasks({ search: id, userId: 2 }).map((row) => row.title);
    expect(forTwo).toContain('Unowned ' + id);
    expect(forTwo).not.toContain('Mine ' + id);
  });

  it('escapes LIKE wildcards in the search filter', () => {
    const id = tag();
    makeTask({ title: 'under_score ' + id });
    makeTask({ title: 'underXscore ' + id });
    makeTask({ title: 'pct% ' + id });
    makeTask({ title: 'pctZZ ' + id });

    expect(scheduledTasksDb.listTasks({ search: 'under_score ' + id })).toHaveLength(1);
    expect(scheduledTasksDb.listTasks({ search: 'pct% ' + id })).toHaveLength(1);
  });

  it('updates a task, preserves explicit nulls and bumps updated_at', () => {
    const created = makeTask({ title: 'Update me', model: 'opus', ruleJson: '{"kind":"daily"}', nextRunAt: '2026-01-01T00:00:00.000Z' });
    getConnection().prepare('UPDATE scheduled_tasks SET updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', created.id);

    const updated = must(
      scheduledTasksDb.updateTask(created.id, {
        title: 'Updated',
        prompt: 'p2',
        projectPath: '/srv/update2',
        provider: 'codex',
        model: null,
        kind: 'cron',
        ruleJson: '{"kind":"cron"}',
        nextRunAt: null,
        enabled: false,
      })
    );
    expect(updated.title).toBe('Updated');
    expect(updated.prompt).toBe('p2');
    expect(updated.project_path).toBe('/srv/update2');
    expect(updated.provider).toBe('codex');
    expect(updated.model).toBeNull();
    expect(updated.kind).toBe('cron');
    expect(updated.rule_json).toBe('{"kind":"cron"}');
    expect(updated.next_run_at).toBeNull();
    expect(updated.enabled).toBe(0);
    expect(updated.updated_at > '2000-01-01T00:00:00.000Z').toBe(true);

    const untouched = must(scheduledTasksDb.updateTask(created.id, {}));
    expect(untouched.title).toBe('Updated');
    expect(untouched.id).toBe(created.id);
    expect(scheduledTasksDb.updateTask(crypto.randomUUID(), { title: 'nope' })).toBeUndefined();
  });

  it('deletes tasks, cascades runs and reports whether a row was removed', () => {
    const task = makeTask({ title: 'Delete me' });
    scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'manual' });
    expect(scheduledTasksDb.countRuns(task.id)).toBe(1);

    expect(scheduledTasksDb.deleteTask(task.id)).toBe(true);
    expect(scheduledTasksDb.getTask(task.id)).toBeUndefined();
    expect(scheduledTasksDb.countRuns(task.id)).toBe(0);
    expect(scheduledTasksDb.listRuns(task.id)).toHaveLength(0);
    expect(scheduledTasksDb.deleteTask(task.id)).toBe(false);
  });

  it('lists due tasks ordered by next_run_at, skipping disabled/null/future rows', () => {
    const id = tag();
    const next = (name: string, nextRunAt: string | null, enabled: boolean) =>
      makeTask({ title: name + ' ' + id, nextRunAt, enabled });

    next('later', '1990-01-02T00:00:00.000Z', true);
    next('earliest', '1990-01-01T00:00:00.000Z', true);
    next('paused', '1980-01-01T00:00:00.000Z', false);
    next('no-next', null, true);
    next('future', '2030-01-01T00:00:00.000Z', true);

    const now = '2026-05-01T00:00:00.000Z';
    const due = scheduledTasksDb.listDueTasks(now);
    expect(due.slice(0, 2).map((row) => row.title)).toEqual(['earliest ' + id, 'later ' + id]);
    expect(due.some((row) => row.title.startsWith('paused ' + id))).toBe(false);
    expect(due.some((row) => row.title.startsWith('no-next ' + id))).toBe(false);
    expect(due.some((row) => row.title.startsWith('future ' + id))).toBe(false);
    expect(scheduledTasksDb.listDueTasks(now, 1).map((row) => row.title)).toEqual(['earliest ' + id]);
  });

  it('advances a task, applies partial patches and bumps updated_at', () => {
    const task = makeTask({ title: 'Advance me' });
    getConnection().prepare('UPDATE scheduled_tasks SET updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', task.id);

    const advanced = must(
      scheduledTasksDb.advanceTask(task.id, {
        nextRunAt: '2030-01-01T00:00:00.000Z',
        lastRunAt: '2026-02-02T02:02:02.000Z',
        lastStatus: 'success',
        lastError: null,
        runCount: 4,
      })
    );
    expect(advanced.next_run_at).toBe('2030-01-01T00:00:00.000Z');
    expect(advanced.last_run_at).toBe('2026-02-02T02:02:02.000Z');
    expect(advanced.last_status).toBe('success');
    expect(advanced.last_error).toBeNull();
    expect(advanced.run_count).toBe(4);
    expect(advanced.updated_at > '2000-01-01T00:00:00.000Z').toBe(true);

    const partial = must(scheduledTasksDb.advanceTask(task.id, { lastError: 'boom' }));
    expect(partial.run_count).toBe(4);
    expect(partial.next_run_at).toBe('2030-01-01T00:00:00.000Z');
    expect(partial.last_error).toBe('boom');
    expect(scheduledTasksDb.advanceTask(crypto.randomUUID(), { lastStatus: 'success' })).toBeUndefined();
  });

  it('creates running runs and finishes them with success or error payloads', () => {
    const task = makeTask({ title: 'Run me' });
    const run = scheduledTasksDb.createRun({
      taskId: task.id,
      status: 'running',
      trigger: 'schedule',
      scheduledFor: '2026-02-01T00:00:00.000Z',
      startedAt: '2026-02-01T00:00:01.000Z',
    });

    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.task_id).toBe(task.id);
    expect(run.status).toBe('running');
    expect(run.trigger).toBe('schedule');
    expect(run.scheduled_for).toBe('2026-02-01T00:00:00.000Z');
    expect(run.started_at).toBe('2026-02-01T00:00:01.000Z');
    expect(run.finished_at).toBeNull();
    expect(run.session_id).toBeNull();
    expect(run.output).toBeNull();
    expect(run.error).toBeNull();

    const finished = must(
      scheduledTasksDb.finishRun(run.id, {
        status: 'success',
        finishedAt: '2026-02-01T00:05:00.000Z',
        sessionId: 'session-1',
        output: 'all good',
      })
    );
    expect(finished.status).toBe('success');
    expect(finished.finished_at).toBe('2026-02-01T00:05:00.000Z');
    expect(finished.session_id).toBe('session-1');
    expect(finished.output).toBe('all good');
    expect(finished.error).toBeNull();

    const manual = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'manual' });
    expect(manual.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const errored = must(scheduledTasksDb.finishRun(manual.id, { status: 'error', error: 'boom' }));
    expect(errored.status).toBe('error');
    expect(errored.error).toBe('boom');
    expect(typeof errored.finished_at).toBe('string');

    expect(scheduledTasksDb.finishRun(crypto.randomUUID(), { status: 'success' })).toBeUndefined();
  });

  it('links a run to its session before the run finishes', () => {
    const task = makeTask({ title: 'In flight' });
    const run = scheduledTasksDb.createRun({
      taskId: task.id,
      status: 'running',
      trigger: 'schedule',
      startedAt: '2026-02-02T00:00:00.000Z',
    });

    const linked = must(scheduledTasksDb.attachRunSession(run.id, 'session-in-flight'));
    expect(linked.session_id).toBe('session-in-flight');
    expect(linked.status).toBe('running');
    expect(linked.finished_at).toBeNull();

    // The origin lookup must already see the in-flight run, so the sidebar can tag and hide
    // the session while the agent is still working.
    expect(scheduledTasksDb.getSessionOrigins(['session-in-flight']).get('session-in-flight')).toMatchObject({
      taskId: task.id,
      taskTitle: 'In flight',
    });
    expect(scheduledTasksDb.getAllScheduledTaskSessionIds().has('session-in-flight')).toBe(true);

    expect(scheduledTasksDb.attachRunSession(crypto.randomUUID(), 'session-x')).toBeUndefined();
    expect(must(scheduledTasksDb.finishRun(run.id, { status: 'success', sessionId: 'session-in-flight' })).session_id).toBe(
      'session-in-flight'
    );
  });

  it('paginates runs by started_at DESC and counts per task', () => {
    const task = makeTask({ title: 'Paged task' });
    const other = makeTask({ title: 'Other task' });
    for (let i = 0; i < 5; i += 1) {
      scheduledTasksDb.createRun({
        taskId: task.id,
        status: 'success',
        trigger: 'schedule',
        startedAt: new Date(Date.UTC(2026, 3, 1, 0, i, 0)).toISOString(),
      });
    }
    scheduledTasksDb.createRun({ taskId: other.id, status: 'success', trigger: 'schedule', startedAt: '2026-04-01T00:00:00.000Z' });

    const all = scheduledTasksDb.listRuns(task.id, 50);
    expect(all.map((row) => row.started_at)).toEqual([
      '2026-04-01T00:04:00.000Z',
      '2026-04-01T00:03:00.000Z',
      '2026-04-01T00:02:00.000Z',
      '2026-04-01T00:01:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
    expect(scheduledTasksDb.listRuns(task.id, 2).map((row) => row.started_at)).toEqual([
      '2026-04-01T00:04:00.000Z',
      '2026-04-01T00:03:00.000Z',
    ]);
    expect(scheduledTasksDb.listRuns(task.id, 2, 2).map((row) => row.started_at)).toEqual([
      '2026-04-01T00:02:00.000Z',
      '2026-04-01T00:01:00.000Z',
    ]);
    expect(scheduledTasksDb.listRuns(task.id, 50, 4).map((row) => row.started_at)).toEqual(['2026-04-01T00:00:00.000Z']);
    expect(scheduledTasksDb.countRuns(task.id)).toBe(5);
    expect(scheduledTasksDb.countRuns(other.id)).toBe(1);
    expect(scheduledTasksDb.listRuns(other.id)).toHaveLength(1);
  });

  it('prunes old runs, keeping the newest N per task only', () => {
    const task = makeTask({ title: 'Prune me' });
    const other = makeTask({ title: 'Prune neighbour' });
    for (let i = 0; i < 5; i += 1) {
      scheduledTasksDb.createRun({
        taskId: task.id,
        status: 'success',
        trigger: 'schedule',
        startedAt: new Date(Date.UTC(2026, 5, 1, 0, i, 0)).toISOString(),
      });
    }
    scheduledTasksDb.createRun({ taskId: other.id, status: 'success', trigger: 'schedule', startedAt: '2026-06-01T00:00:00.000Z' });

    expect(scheduledTasksDb.pruneRuns(task.id, 2)).toBe(3);
    expect(scheduledTasksDb.countRuns(task.id)).toBe(2);
    expect(scheduledTasksDb.listRuns(task.id, 50).map((row) => row.started_at)).toEqual([
      '2026-06-01T00:04:00.000Z',
      '2026-06-01T00:03:00.000Z',
    ]);
    expect(scheduledTasksDb.pruneRuns(task.id, 50)).toBe(0);
    expect(scheduledTasksDb.countRuns(other.id)).toBe(1);

    expect(scheduledTasksDb.pruneRuns(other.id, 0)).toBe(1);
    expect(scheduledTasksDb.countRuns(other.id)).toBe(0);
  });

  it('upgrades a pre-script-gate database in place and keeps legacy rows working', () => {
    const legacy = must(scheduledTasksDb.getTask(legacyTaskId));
    expect(legacy.title).toBe('Legacy gated task');
    expect(legacy.command).toBeNull();
    expect(legacy.command_timeout_seconds).toBeNull();

    const legacyRun = scheduledTasksDb.createRun({ taskId: legacyTaskId, status: 'running', trigger: 'manual' });
    expect(legacyRun.script_exit_code).toBeNull();
    expect(legacyRun.script_output).toBeNull();
    expect(legacyRun.prompt_used).toBeNull();

    const upgraded = must(scheduledTasksDb.updateTask(legacyTaskId, { command: 'echo hi', commandTimeoutSeconds: 90 }));
    expect(upgraded.command).toBe('echo hi');
    expect(upgraded.command_timeout_seconds).toBe(90);

    // runMigrations() must stay idempotent after the in-place upgrade.
    const columnsBefore = (getConnection().prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]).map(
      (row) => row.name
    );
    runMigrations();
    const columnsAfter = (getConnection().prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]).map(
      (row) => row.name
    );
    expect(columnsAfter).toEqual(columnsBefore);
    expect(columnsAfter).toContain('command');
    expect(columnsAfter).toContain('command_timeout_seconds');
  });

  it('round-trips the script gate on tasks and clears it with explicit nulls', () => {
    const created = makeTask({ title: 'Gated task', command: 'node gate.js', commandTimeoutSeconds: 120 });
    expect(created.command).toBe('node gate.js');
    expect(created.command_timeout_seconds).toBe(120);
    expect(must(scheduledTasksDb.getTask(created.id)).command).toBe('node gate.js');

    const updated = must(
      scheduledTasksDb.updateTask(created.id, { command: 'node other.js', commandTimeoutSeconds: 300 })
    );
    expect(updated.command).toBe('node other.js');
    expect(updated.command_timeout_seconds).toBe(300);

    // snake_case aliases for callers that already hold a row.
    const aliased = must(scheduledTasksDb.updateTask(created.id, { command_timeout_seconds: 45 }));
    expect(aliased.command_timeout_seconds).toBe(45);
    expect(aliased.command).toBe('node other.js');

    const cleared = must(scheduledTasksDb.updateTask(created.id, { command: null, commandTimeoutSeconds: null }));
    expect(cleared.command).toBeNull();
    expect(cleared.command_timeout_seconds).toBeNull();
    expect(must(scheduledTasksDb.getTask(created.id)).command).toBeNull();

    const aliasedCreate = makeTask({ title: 'Alias task', command_timeout_seconds: 75 });
    expect(aliasedCreate.command).toBeNull();
    expect(aliasedCreate.command_timeout_seconds).toBe(75);
  });

  it('stores script fields on runs and accepts the skipped status', () => {
    const task = makeTask({ title: 'Script gate task', command: 'node gate.js' });

    const running = scheduledTasksDb.createRun({
      taskId: task.id,
      status: 'running',
      trigger: 'schedule',
      startedAt: '2026-07-01T00:00:00.000Z',
      promptUsed: 'effective prompt',
    });
    expect(running.script_exit_code).toBeNull();
    expect(running.script_output).toBeNull();
    expect(running.prompt_used).toBe('effective prompt');

    const skipped = must(
      scheduledTasksDb.finishRun(running.id, {
        status: 'skipped',
        finishedAt: '2026-07-01T00:00:02.000Z',
        output: 'nothing to do',
        scriptExitCode: 0,
        scriptOutput: '{"skip":true,"reason":"nothing to do"}',
        promptUsed: null,
      })
    );
    expect(skipped.status).toBe('skipped');
    expect(skipped.output).toBe('nothing to do');
    expect(skipped.script_exit_code).toBe(0);
    expect(skipped.script_output).toBe('{"skip":true,"reason":"nothing to do"}');
    expect(skipped.prompt_used).toBeNull();
    expect(skipped.finished_at).toBe('2026-07-01T00:00:02.000Z');

    // A failing gate finishes as error with the exit code preserved.
    const failed = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'manual' });
    const errored = must(
      scheduledTasksDb.finishRun(failed.id, {
        status: 'error',
        error: 'script_exit_3',
        scriptExitCode: 3,
        scriptOutput: 'boom',
        script_exit_code: 3,
        script_output: 'boom',
      })
    );
    expect(errored.status).toBe('error');
    expect(errored.error).toBe('script_exit_3');
    expect(errored.script_exit_code).toBe(3);
    expect(errored.script_output).toBe('boom');
    expect(errored.prompt_used).toBeNull();

    // The run history surfaces the new columns.
    const runs = scheduledTasksDb.listRuns(task.id, 10);
    expect(runs.map((row) => row.status)).toEqual(['error', 'skipped']);
    expect(runs[1].script_output).toBe('{"skip":true,"reason":"nothing to do"}');
  });

  // ── Session origins (docs section 9.1) ────────────────────────────────────

  it('creates the scheduled_task_runs session index after migrations, idempotently', () => {
    const db = getConnection();
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_scheduled_task_runs_session'")
      .get() as { name: string } | undefined;
    expect(index?.name).toBe('idx_scheduled_task_runs_session');

    const columns = (db.prepare('PRAGMA index_info(idx_scheduled_task_runs_session)').all() as { name: string }[]).map(
      (row) => row.name
    );
    expect(columns).toEqual(['session_id']);

    // runMigrations() runs on every server start, so a second pass must be a no-op.
    runMigrations();
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_scheduled_task_runs_session'")
      .get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('returns one origin per session, joins the task title and lets the newest run win', () => {
    const id = tag();
    const olderTask = makeTask({ title: 'Older origin ' + id });
    const newerTask = makeTask({ title: 'Newer origin ' + id });
    const sessionId = 'session-newest-' + id;
    const otherSession = 'session-other-' + id;

    const olderRun = scheduledTasksDb.createRun({
      taskId: olderTask.id,
      status: 'running',
      trigger: 'schedule',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    scheduledTasksDb.finishRun(olderRun.id, { status: 'success', sessionId });

    const newestRun = scheduledTasksDb.createRun({
      taskId: newerTask.id,
      status: 'running',
      trigger: 'manual',
      startedAt: '2026-01-02T00:00:00.000Z',
    });
    scheduledTasksDb.finishRun(newestRun.id, { status: 'success', sessionId });

    const olderRunOfNewerTask = scheduledTasksDb.createRun({
      taskId: newerTask.id,
      status: 'running',
      trigger: 'schedule',
      startedAt: '2026-01-01T12:00:00.000Z',
    });
    scheduledTasksDb.finishRun(olderRunOfNewerTask.id, { status: 'error', sessionId });

    const isolatedRun = scheduledTasksDb.createRun({
      taskId: olderTask.id,
      status: 'running',
      trigger: 'schedule',
      startedAt: '2026-01-03T00:00:00.000Z',
    });
    scheduledTasksDb.finishRun(isolatedRun.id, { status: 'success', sessionId: otherSession });

    const origins = scheduledTasksDb.getSessionOrigins([sessionId, otherSession]);
    expect(origins.size).toBe(2);
    expect(origins.get(sessionId)).toEqual({
      taskId: newerTask.id,
      taskTitle: 'Newer origin ' + id,
      startedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(origins.get(otherSession)).toEqual({
      taskId: olderTask.id,
      taskTitle: 'Older origin ' + id,
      startedAt: '2026-01-03T00:00:00.000Z',
    });
  });

  it('falls back to the task id as the title when the task row is gone', () => {
    const id = tag();
    const sessionId = 'session-orphan-' + id;
    const task = makeTask({ title: 'Vanishing task ' + id });
    const run = scheduledTasksDb.createRun({
      taskId: task.id,
      status: 'running',
      trigger: 'schedule',
      startedAt: '2026-03-01T00:00:00.000Z',
    });
    scheduledTasksDb.finishRun(run.id, { status: 'success', sessionId });

    // ON DELETE CASCADE would remove the run, so drop the task with foreign keys temporarily
    // off to reproduce a run whose task row no longer exists.
    const db = getConnection();
    db.pragma('foreign_keys = OFF');
    try {
      db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(task.id);
    } finally {
      db.pragma('foreign_keys = ON');
    }
    expect(scheduledTasksDb.getTask(task.id)).toBeUndefined();
    expect(scheduledTasksDb.countRuns(task.id)).toBe(1);

    expect(scheduledTasksDb.getSessionOrigins([sessionId]).get(sessionId)).toEqual({
      taskId: task.id,
      taskTitle: task.id,
      startedAt: '2026-03-01T00:00:00.000Z',
    });
  });

  it('dedupes repeated runs and repeated input ids, and returns an empty Map for no input', () => {
    const id = tag();
    const task = makeTask({ title: 'Dedupe ' + id });
    const sessionId = 'session-dedupe-' + id;
    for (const startedAt of ['2026-04-01T00:00:00.000Z', '2026-04-02T00:00:00.000Z', '2026-04-03T00:00:00.000Z']) {
      const run = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'schedule', startedAt });
      scheduledTasksDb.finishRun(run.id, { status: 'success', sessionId });
    }

    const origins = scheduledTasksDb.getSessionOrigins([sessionId, sessionId, sessionId]);
    expect(origins.size).toBe(1);
    expect(origins.get(sessionId)).toEqual({
      taskId: task.id,
      taskTitle: 'Dedupe ' + id,
      startedAt: '2026-04-03T00:00:00.000Z',
    });

    expect(scheduledTasksDb.getSessionOrigins([]).size).toBe(0);
    expect(scheduledTasksDb.getSessionOrigins(['no-such-session-' + id]).size).toBe(0);
  });

  it('returns every scheduled-task session id as a Set, skipping runs without a session', () => {
    const id = tag();
    const task = makeTask({ title: 'Set task ' + id });
    const first = 'session-set-a-' + id;
    const second = 'session-set-b-' + id;

    const firstRun = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'schedule' });
    scheduledTasksDb.finishRun(firstRun.id, { status: 'success', sessionId: first });
    const secondRun = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'manual' });
    scheduledTasksDb.finishRun(secondRun.id, { status: 'success', sessionId: second });
    // A run that never started an agent must not contribute anything.
    scheduledTasksDb.createRun({ taskId: task.id, status: 'skipped', trigger: 'schedule' });

    const ids = scheduledTasksDb.getAllScheduledTaskSessionIds();
    expect(ids).toBeInstanceOf(Set);
    expect(ids.has(first)).toBe(true);
    expect(ids.has(second)).toBe(true);
    expect(ids.has('')).toBe(false);
    for (const value of ids) {
      expect(typeof value).toBe('string');
      expect(value).not.toBe('');
    }

    const expected = (
      getConnection()
        .prepare('SELECT DISTINCT session_id FROM scheduled_task_runs WHERE session_id IS NOT NULL')
        .all() as { session_id: string }[]
    ).map((row) => row.session_id);
    expect(ids.size).toBe(expected.length);
    for (const value of expected) expect(ids.has(value)).toBe(true);
  });

  it('creates, reads, updates and deletes presets', () => {
    const id = 'preset-' + tag();
    const created = scheduledTasksDb.createPreset({
      id,
      source: 'builtin',
      name: 'Nightly suite',
      description: 'desc',
      icon: 'icon',
      version: '1.0.0',
    });

    expect(created.id).toBe(id);
    expect(created.user_id).toBeNull();
    expect(created.source).toBe('builtin');
    expect(created.name).toBe('Nightly suite');
    expect(created.description).toBe('desc');
    expect(created.icon).toBe('icon');
    expect(created.version).toBe('1.0.0');
    // Unlike tasks, a fresh preset is disabled until it is installed/enabled.
    expect(created.enabled).toBe(0);
    expect(created.project_path).toBeNull();
    expect(created.created_at).toBe(created.updated_at);
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(must(scheduledTasksDb.getPreset(id)).name).toBe('Nightly suite');
    expect(scheduledTasksDb.getPreset(crypto.randomUUID())).toBeUndefined();

    getConnection()
      .prepare('UPDATE scheduled_task_presets SET updated_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', id);
    const updated = must(
      scheduledTasksDb.updatePreset(id, {
        name: 'Renamed',
        description: null,
        icon: null,
        version: '2.0.0',
        enabled: true,
        projectPath: '/srv/preset-' + id,
        userId: 5,
      })
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.description).toBeNull();
    expect(updated.icon).toBeNull();
    expect(updated.version).toBe('2.0.0');
    expect(updated.enabled).toBe(1);
    expect(updated.project_path).toBe('/srv/preset-' + id);
    expect(updated.user_id).toBe(5);
    expect(updated.updated_at > '2000-01-01T00:00:00.000Z').toBe(true);

    const untouched = must(scheduledTasksDb.updatePreset(id, {}));
    expect(untouched.name).toBe('Renamed');
    expect(untouched.enabled).toBe(1);
    expect(untouched.user_id).toBe(5);
    expect(scheduledTasksDb.updatePreset('no-such-' + id, { name: 'x' })).toBeUndefined();

    expect(scheduledTasksDb.deletePreset(id)).toBe(true);
    expect(scheduledTasksDb.getPreset(id)).toBeUndefined();
    expect(scheduledTasksDb.deletePreset(id)).toBe(false);
  });

  it('generates a preset id on demand and honours an explicit disabled flag', () => {
    const id = tag();
    const custom = scheduledTasksDb.createPreset({
      source: 'custom',
      name: 'Mine ' + id,
      projectPath: '/srv/custom-' + id,
      enabled: false,
    });
    expect(custom.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(custom.enabled).toBe(0);
    expect(custom.project_path).toBe('/srv/custom-' + id);
    expect(custom.user_id).toBeNull();
    expect(custom.description).toBeNull();
    expect(custom.icon).toBeNull();
    expect(custom.version).toBeNull();

    expect(scheduledTasksDb.createPreset({ source: 'builtin', name: 'On ' + id, enabled: true }).enabled).toBe(1);
  });

  it('replaces preset tasks in position order, snapshots the rule and cascade-deletes them', () => {
    const id = 'preset-' + tag();
    scheduledTasksDb.createPreset({ id, source: 'builtin', name: 'Tasks ' + id });
    expect(scheduledTasksDb.listPresetTasks(id)).toEqual([]);
    expect(scheduledTasksDb.replacePresetTasks(id, [])).toEqual([]);
    expect(scheduledTasksDb.replacePresetTasks('no-such-' + id, [])).toEqual([]);

    // Explicit positions win over the array index.
    const positioned = scheduledTasksDb.replacePresetTasks(id, [
      { id: 'tpl-second', title: 'Second', prompt: 'p2', kind: 'daily', rule: { kind: 'daily' }, position: 2 },
      { id: 'tpl-first', title: 'First', prompt: 'p1', kind: 'daily', rule: { kind: 'daily' }, position: 1 },
    ]);
    expect(positioned.map((row) => row.id)).toEqual(['tpl-first', 'tpl-second']);
    expect(positioned.map((row) => row.position)).toEqual([1, 2]);

    // A replacement drops the previous templates and defaults position to the index.
    const replaced = scheduledTasksDb.replacePresetTasks(id, [
      {
        id: 'tpl-x',
        title: 'X',
        description: 'template x',
        prompt: 'px',
        kind: 'daily',
        rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      },
      {
        id: 'tpl-y',
        title: 'Y',
        prompt: 'py',
        provider: 'codex',
        model: 'gpt',
        kind: 'interval',
        ruleJson: '{"kind":"interval","everySeconds":600}',
        command: 'node gate.js',
        commandTimeoutSeconds: 30,
      },
    ]);

    expect(replaced.map((row) => row.id)).toEqual(['tpl-x', 'tpl-y']);
    expect(replaced.map((row) => row.position)).toEqual([0, 1]);
    const [first, second] = replaced;
    expect(first.description).toBe('template x');
    expect(first.provider).toBe('claude');
    expect(first.model).toBeNull();
    expect(first.rule_json).toBe('{"kind":"daily","time":"09:00","timeZone":"UTC"}');
    expect(first.command).toBeNull();
    expect(first.command_timeout_seconds).toBeNull();
    expect(first.created_at).toBe(first.updated_at);
    expect(second.rule_json).toBe('{"kind":"interval","everySeconds":600}');
    expect(second.provider).toBe('codex');
    expect(second.model).toBe('gpt');
    expect(second.command).toBe('node gate.js');
    expect(second.command_timeout_seconds).toBe(30);

    // snake_case alias for callers that already hold a serialized row.
    const aliased = scheduledTasksDb.replacePresetTasks(id, [
      { id: 'tpl-z', title: 'Z', prompt: 'pz', kind: 'daily', rule: {}, command_timeout_seconds: 75 },
    ]);
    expect(aliased[0].command_timeout_seconds).toBe(75);

    // Deleting the preset removes its templates (no orphans left behind).
    expect(scheduledTasksDb.deletePreset(id)).toBe(true);
    expect(scheduledTasksDb.listPresetTasks(id)).toEqual([]);
    const leftovers = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM scheduled_task_preset_tasks WHERE preset_id = ?')
      .get(id) as { count: number };
    expect(leftovers.count).toBe(0);
  });

  it('lists presets filtered by source and project, keeping builtins visible everywhere', () => {
    const id = tag();
    const builtinAlpha = 'preset-alpha-' + id;
    const builtinZulu = 'preset-zulu-' + id;
    const customHere = 'preset-here-' + id;
    const customThere = 'preset-there-' + id;
    const projectPath = '/srv/proj-' + id;

    scheduledTasksDb.createPreset({ id: builtinAlpha, source: 'builtin', name: 'Alpha ' + id });
    scheduledTasksDb.createPreset({ id: builtinZulu, source: 'builtin', name: 'Zulu ' + id });
    scheduledTasksDb.createPreset({ id: customHere, source: 'custom', name: 'Here ' + id, projectPath });
    scheduledTasksDb.createPreset({ id: customThere, source: 'custom', name: 'There ' + id, projectPath: '/srv/other-' + id });

    const byId = (rows: { id: string }[]): string[] => rows.map((row) => row.id);
    const all = byId(scheduledTasksDb.listPresets());
    expect(all).toEqual(expect.arrayContaining([builtinAlpha, builtinZulu, customHere, customThere]));

    // Builtin rows are returned for every project, custom rows only for their own.
    const here = byId(scheduledTasksDb.listPresets({ projectPath }));
    expect(here).toContain(builtinAlpha);
    expect(here).toContain(builtinZulu);
    expect(here).toContain(customHere);
    expect(here).not.toContain(customThere);
    // A trailing separator still matches (normalizeProjectPath).
    expect(byId(scheduledTasksDb.listPresets({ projectPath: projectPath + '/' }))).toContain(customHere);
    // No project context: custom rows are hidden, builtins stay.
    expect(byId(scheduledTasksDb.listPresets({ projectPath: null }))).not.toContain(customHere);
    expect(byId(scheduledTasksDb.listPresets({ projectPath: null }))).toContain(builtinAlpha);
    expect(byId(scheduledTasksDb.listPresets({ projectPath: '' }))).not.toContain(customHere);
    // Unknown project.
    expect(byId(scheduledTasksDb.listPresets({ projectPath: '/srv/nowhere-' + id }))).not.toContain(customHere);

    // source and projectPath combine, and builtins are ordered by name.
    expect(byId(scheduledTasksDb.listPresets({ source: 'custom', projectPath }))).toEqual([customHere]);
    const builtinOrder = byId(scheduledTasksDb.listPresets({ source: 'builtin' })).filter(
      (presetId) => presetId === builtinAlpha || presetId === builtinZulu
    );
    expect(builtinOrder).toEqual([builtinAlpha, builtinZulu]);
  });

  it('links real tasks to a preset and lists them by preset', () => {
    const id = tag();
    const presetId = 'preset-' + id;
    scheduledTasksDb.createPreset({ id: presetId, source: 'custom', name: 'Link ' + id, projectPath: '/srv/link-' + id });

    const linked = makeTask({ title: 'Linked ' + id, presetId, presetTaskId: 'tpl-1' });
    expect(linked.preset_id).toBe(presetId);
    expect(linked.preset_task_id).toBe('tpl-1');

    makeTask({ title: 'Unlinked ' + id });
    const second = makeTask({ title: 'Linked too ' + id, presetId, presetTaskId: 'tpl-2' });
    expect(second.preset_id).toBe(presetId);

    // Oldest first, and unlinked tasks never show up.
    expect(scheduledTasksDb.listTasksByPreset(presetId).map((row) => row.title)).toEqual([
      'Linked ' + id,
      'Linked too ' + id,
    ]);
    expect(scheduledTasksDb.listTasksByPreset('no-such-' + id)).toEqual([]);
    expect(scheduledTasksDb.listTasksByPreset(presetId).every((row) => row.preset_id === presetId)).toBe(true);

    // Relink and clear through updateTask.
    const relinked = must(scheduledTasksDb.updateTask(second.id, { presetId: 'other-' + id, presetTaskId: null }));
    expect(relinked.preset_id).toBe('other-' + id);
    expect(relinked.preset_task_id).toBeNull();
    expect(scheduledTasksDb.listTasksByPreset(presetId).map((row) => row.id)).toEqual([linked.id]);

    const cleared = must(scheduledTasksDb.updateTask(linked.id, { presetId: null, presetTaskId: null }));
    expect(cleared.preset_id).toBeNull();
    expect(cleared.preset_task_id).toBeNull();
    expect(scheduledTasksDb.listTasksByPreset(presetId)).toEqual([]);
  });

  it('adds the preset columns and tables to a database created before the feature', () => {
    const legacy = must(scheduledTasksDb.getTask(legacyTaskId));
    expect(legacy.preset_id).toBeNull();
    expect(legacy.preset_task_id).toBeNull();

    const db = getConnection();
    const columns = (db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]).map((row) => row.name);
    expect(columns).toContain('preset_id');
    expect(columns).toContain('preset_task_id');

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (row) => row.name
    );
    expect(tables).toContain('scheduled_task_presets');
    expect(tables).toContain('scheduled_task_preset_tasks');

    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
      (row) => row.name
    );
    expect(indexes).toContain('idx_scheduled_tasks_preset');
    expect(indexes).toContain('idx_scheduled_task_presets_source');
    expect(indexes).toContain('idx_scheduled_task_preset_tasks_preset');

    // Re-running the migrations keeps the schema stable.
    runMigrations();
    runMigrations();
    const columnsAfter = (db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]).map(
      (row) => row.name
    );
    expect(columnsAfter).toEqual(columns);

    // The preset tables are usable on the upgraded database.
    const presetId = 'upgraded-' + tag();
    scheduledTasksDb.createPreset({ id: presetId, source: 'builtin', name: 'Upgraded ' + presetId });
    expect(
      scheduledTasksDb.replacePresetTasks(presetId, [
        { id: 'tpl-upgraded', title: 'T', prompt: 'p', kind: 'daily', rule: { kind: 'daily' } },
      ])
    ).toHaveLength(1);
    expect(scheduledTasksDb.deletePreset(presetId)).toBe(true);
  });
});

describe('parameters (docs section 12.4)', () => {
  const columns = (table: string): string[] =>
    (getConnection().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

  it('adds params_json to a database created before the feature and reads legacy rows as NULL', () => {
    // The database was created from the pre-script-gate DDL in beforeAll(), so these
    // columns exist only because migrations.ts added them.
    expect(columns('scheduled_tasks')).toContain('params_json');
    expect(columns('scheduled_task_runs')).toContain('params_json');
    expect(columns('scheduled_task_preset_tasks')).toContain('params_json');

    expect(must(scheduledTasksDb.getTask(legacyTaskId)).params_json).toBeNull();
  });

  it('round-trips params_json on tasks, runs and preset templates', () => {
    const paramsJson = JSON.stringify([{ name: 'region', type: 'string', default: 'eu' }]);
    const task = makeTask({ title: 'Param task ' + tag(), paramsJson });
    expect(task.params_json).toBe(paramsJson);
    expect(must(scheduledTasksDb.getTask(task.id)).params_json).toBe(paramsJson);

    expect(must(scheduledTasksDb.updateTask(task.id, { paramsJson: '[]' })).params_json).toBe('[]');
    expect(must(scheduledTasksDb.updateTask(task.id, { paramsJson: null })).params_json).toBeNull();

    const run = scheduledTasksDb.createRun({
      taskId: task.id,
      status: 'running',
      trigger: 'manual',
      paramsJson: '{"region":"eu"}',
    });
    expect(run.params_json).toBe('{"region":"eu"}');
    expect(must(scheduledTasksDb.listRuns(task.id, 5)[0]).params_json).toBe('{"region":"eu"}');

    const presetId = 'params-' + tag();
    scheduledTasksDb.createPreset({ id: presetId, source: 'custom', name: 'P' });
    const templates = scheduledTasksDb.replacePresetTasks(presetId, [
      { id: 'tpl-params', title: 'T', prompt: 'p', kind: 'daily', rule: { kind: 'daily' }, paramsJson },
    ]);
    expect(templates[0].params_json).toBe(paramsJson);

    // snake_case alias for callers that already hold a serialized row.
    const aliased = scheduledTasksDb.replacePresetTasks(presetId, [
      { id: 'tpl-params-2', title: 'T2', prompt: 'p', kind: 'daily', rule: { kind: 'daily' }, params_json: '[]' },
    ]);
    expect(aliased[0].params_json).toBe('[]');
    scheduledTasksDb.deletePreset(presetId);
  });
});

describe('agent-started tracking (docs section 14.1)', () => {
  const columns = (table: string): string[] =>
    (getConnection().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

  it('adds agent_started_at to a database created before the feature', () => {
    // The database was created from the pre-feature DDL in beforeAll().
    expect(columns('scheduled_task_runs')).toContain('agent_started_at');
    // Legacy rows stay NULL: nothing historical is reported as running.
    expect(scheduledTasksDb.countRunningAgentRuns()).toBe(0);
  });

  it('marks a run once and never moves the timestamp', () => {
    const task = makeTask({ title: 'Agent started ' + tag() });
    const run = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'schedule' });
    expect(run.agent_started_at).toBeNull();

    const marked = must(scheduledTasksDb.markRunAgentStarted(run.id));
    expect(marked.agent_started_at).toBeTruthy();
    const first = marked.agent_started_at;

    const again = must(scheduledTasksDb.markRunAgentStarted(run.id));
    expect(again.agent_started_at).toBe(first);

    scheduledTasksDb.finishRun(run.id, { status: 'success' });
  });

  it('counts and lists the agent-started runs in flight', () => {
    const task = makeTask({ title: 'Running agent ' + tag() });
    const other = makeTask({ title: 'Other agent ' + tag() });
    const before = scheduledTasksDb.countRunningAgentRuns();

    // Gate phase: the run is 'running' but the agent has not started.
    const gateRun = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'schedule' });
    expect(gateRun.agent_started_at).toBeNull();
    expect(scheduledTasksDb.countRunningAgentRuns()).toBe(before);

    // A skipped run whose agent never started is not counted either.
    scheduledTasksDb.finishRun(gateRun.id, { status: 'skipped' });

    const agentRun = scheduledTasksDb.createRun({
      taskId: task.id,
      status: 'running',
      trigger: 'schedule',
      projectPath: '/tmp/one',
    });
    scheduledTasksDb.markRunAgentStarted(agentRun.id);
    expect(scheduledTasksDb.countRunningAgentRuns()).toBe(before + 1);

    // §22: the running list joins the task title and keeps the run's project.
    const listed = must(scheduledTasksDb.listRunningAgentRuns(10).find((row) => row.id === agentRun.id));
    expect(listed.project_path).toBe('/tmp/one');
    expect(listed.task_title).toBe(task.title);

    scheduledTasksDb.finishRun(agentRun.id, { status: 'success' });
    expect(scheduledTasksDb.countRunningAgentRuns()).toBe(before);

    // §22: a multi-project task contributes one running run per project.
    const first = scheduledTasksDb.createRun({
      taskId: other.id,
      status: 'running',
      trigger: 'schedule',
      projectPath: '/tmp/a',
    });
    const second = scheduledTasksDb.createRun({
      taskId: other.id,
      status: 'running',
      trigger: 'schedule',
      projectPath: '/tmp/b',
    });
    scheduledTasksDb.markRunAgentStarted(first.id);
    scheduledTasksDb.markRunAgentStarted(second.id);
    expect(scheduledTasksDb.countRunningAgentRuns()).toBe(before + 2);

    scheduledTasksDb.finishRun(first.id, { status: 'error' });
    scheduledTasksDb.finishRun(second.id, { status: 'error' });
    expect(scheduledTasksDb.countRunningAgentRuns()).toBe(before);
  });

  it('round-trips project_paths_json on tasks and project_path on runs (docs section 22)', () => {
    const task = makeTask({
      title: 'Multi project ' + tag(),
      projectPath: '/tmp/primary',
      projectPathsJson: JSON.stringify(['/tmp/primary', '/tmp/secondary']),
    });
    expect(must(scheduledTasksDb.getTask(task.id)).project_paths_json).toBe(
      JSON.stringify(['/tmp/primary', '/tmp/secondary'])
    );
    expect(
      must(scheduledTasksDb.updateTask(task.id, { projectPathsJson: JSON.stringify(['/tmp/x']) })).project_paths_json
    ).toBe(JSON.stringify(['/tmp/x']));
    expect(must(scheduledTasksDb.updateTask(task.id, { projectPathsJson: null })).project_paths_json).toBeNull();

    const run = scheduledTasksDb.createRun({
      taskId: task.id,
      status: 'running',
      trigger: 'manual',
      projectPath: '/tmp/secondary',
    });
    expect(run.project_path).toBe('/tmp/secondary');
  });

  it('fails every interrupted run and reports how many', () => {
    const task = makeTask({ title: 'Interrupted ' + tag() });
    const interrupted = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'schedule' });
    scheduledTasksDb.markRunAgentStarted(interrupted.id);
    const finished = scheduledTasksDb.createRun({ taskId: task.id, status: 'running', trigger: 'schedule' });
    scheduledTasksDb.finishRun(finished.id, { status: 'success' });

    const finishedAt = new Date().toISOString();
    // Earlier tests in this file also leave 'running' rows behind; the sweep must
    // fail exactly those, so measure instead of assuming a single row.
    const runningBefore = must(
      getConnection().prepare("SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE status = 'running'").get() as {
        count: number;
      }
    ).count;
    expect(runningBefore).toBeGreaterThanOrEqual(1);
    expect(scheduledTasksDb.failInterruptedRuns(finishedAt, 'server_restart')).toBe(runningBefore);

    const after = must(scheduledTasksDb.listRuns(task.id, 5, 0).find((row) => row.id === interrupted.id));
    expect(after.status).toBe('error');
    expect(after.error).toBe('server_restart');
    expect(after.finished_at).toBe(finishedAt);

    // Already-finished rows are untouched and the sweep is idempotent.
    expect(must(scheduledTasksDb.listRuns(task.id, 5, 0).find((row) => row.id === finished.id)).status).toBe('success');
    expect(scheduledTasksDb.failInterruptedRuns(finishedAt, 'server_restart')).toBe(0);
    expect(scheduledTasksDb.countRunningAgentRuns()).toBe(0);
  });
});
