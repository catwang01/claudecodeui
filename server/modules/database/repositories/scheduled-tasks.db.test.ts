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

beforeAll(async () => {
  // Pre-create an empty database file so the connection module does not copy the
  // real legacy auth.db into the temp location.
  await fs.writeFile(databasePath, '');
  runMigrations();
  // runMigrations() runs on every server start; the scheduled-task schemas must be idempotent.
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
    expect(created.created_at).toBe(created.updated_at);
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const fetched = must(scheduledTasksDb.getTask(created.id));
    expect(fetched.title).toBe('Nightly build');
    expect(fetched.kind).toBe('interval');
    expect(fetched.rule_json).toBe('{"kind":"interval","everySeconds":300}');
    expect(scheduledTasksDb.getTask(crypto.randomUUID())).toBeUndefined();
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
    });

    expect(created.id).toBe(id);
    expect(created.user_id).toBe(7);
    expect(created.provider).toBe('cursor');
    expect(created.model).toBe('gpt');
    expect(created.enabled).toBe(0);
    expect(created.next_run_at).toBeNull();
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
});
