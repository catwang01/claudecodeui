import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createScheduler, getSchedulerState } from './service.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const now = () => NOW;

function makeTask(overrides = {}) {
  return {
    id: 't1',
    user_id: 1,
    title: 'Nightly docs',
    prompt: 'do stuff',
    project_path: '/tmp/scheduled-project',
    provider: 'claude',
    model: null,
    kind: 'interval',
    rule_json: JSON.stringify({ kind: 'interval', everySeconds: 60 }),
    next_run_at: new Date(NOW).toISOString(),
    last_run_at: null,
    last_status: null,
    last_error: null,
    enabled: 1,
    run_count: 0,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makeRepo(tasks = []) {
  return {
    listDueTasks: vi.fn(async () => tasks),
    advanceTask: vi.fn((id, patch) => ({ id, ...patch })),
    getTask: vi.fn((id) => tasks.find((task) => task.id === id)),
  };
}

function makeRunner(result) {
  let seq = 0;
  const startTaskRun = vi.fn((task, options) => {
    const run = {
      id: `run-${++seq}`,
      task_id: task.id,
      status: 'running',
      trigger: options.trigger,
      scheduled_for: options.scheduledFor ?? null,
      started_at: new Date(NOW).toISOString(),
      finished_at: null,
      session_id: null,
      output: null,
      error: null,
    };
    const done = Promise.resolve(
      typeof result === 'function' ? result(task, options, run) : (result ?? {
        run: { ...run, status: 'success', finished_at: new Date(NOW).toISOString() },
        status: 'success',
        sessionId: null,
        output: null,
        error: null,
      })
    );
    return { run, done };
  });
  return { startTaskRun };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  delete process.env.SCHEDULED_TASKS_ENABLED;
  delete process.env.SCHEDULED_TASKS_TICK_MS;
});

afterEach(() => {
  delete process.env.SCHEDULED_TASKS_ENABLED;
  delete process.env.SCHEDULED_TASKS_TICK_MS;
  vi.useRealTimers();
});

describe('createScheduler', () => {
  it('executes a due task and advances it before and after the run', async () => {
    const task = makeTask();
    const repo = makeRepo([task]);
    const nextIso = new Date(NOW + 60000).toISOString();
    const computeNextRun = vi.fn(() => NOW + 60000);
    const runner = makeRunner({
      run: { id: 'run-1', task_id: 't1', status: 'success', finished_at: new Date(NOW + 5000).toISOString() },
      status: 'success',
      sessionId: 'sess-1',
      output: 'ok',
      error: null,
    });

    const scheduler = createScheduler({ repo, runner, now, tickMs: 1000, computeNextRun });
    await scheduler.tick();
    await scheduler.whenIdle();

    expect(repo.listDueTasks).toHaveBeenCalledWith(new Date(NOW).toISOString());
    expect(computeNextRun).toHaveBeenCalledTimes(1);
    expect(runner.startTaskRun).toHaveBeenCalledWith(task, {
      trigger: 'schedule',
      scheduledFor: task.next_run_at,
    });

    expect(repo.advanceTask).toHaveBeenCalledTimes(2);
    const preRun = repo.advanceTask.mock.calls[0][1];
    expect(preRun).toEqual({
      nextRunAt: nextIso,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      runCount: 0,
    });
    const postRun = repo.advanceTask.mock.calls[1][1];
    expect(postRun).toEqual({
      nextRunAt: nextIso,
      lastRunAt: new Date(NOW + 5000).toISOString(),
      lastStatus: 'success',
      lastError: null,
      runCount: 1,
    });
  });

  it('records an error run on the task', async () => {
    const task = makeTask();
    const repo = makeRepo([task]);
    const runner = makeRunner((_task, _options, run) => ({
      run: { ...run, status: 'error', finished_at: new Date(NOW).toISOString() },
      status: 'error',
      sessionId: null,
      output: null,
      error: 'boom',
    }));

    const scheduler = createScheduler({ repo, runner, now, tickMs: 1000, computeNextRun: () => NOW + 1000 });
    await scheduler.tick();
    await scheduler.whenIdle();

    expect(repo.advanceTask.mock.calls[1][1]).toMatchObject({ lastStatus: 'error', lastError: 'boom', runCount: 1 });
  });

  it('exhausts one-shot tasks (nextRunAt null) without computing a next run', async () => {
    const task = makeTask({
      kind: 'once',
      rule_json: JSON.stringify({ kind: 'once', at: '2026-01-01T00:00:00.000Z' }),
    });
    const repo = makeRepo([task]);
    const computeNextRun = vi.fn(() => NOW + 1000);
    const runner = makeRunner();

    const scheduler = createScheduler({ repo, runner, now, tickMs: 1000, computeNextRun });
    await scheduler.tick();
    await scheduler.whenIdle();

    expect(computeNextRun).not.toHaveBeenCalled();
    expect(repo.advanceTask.mock.calls[0][1].nextRunAt).toBeNull();
    expect(repo.advanceTask.mock.calls[1][1].nextRunAt).toBeNull();
    expect(repo.advanceTask.mock.calls[1][1].runCount).toBe(1);
  });

  it('does not start a second run while a task is in flight', async () => {
    const task = makeTask();
    const repo = makeRepo([task]);
    const pending = deferred();
    const runner = makeRunner(() => pending.promise);

    const scheduler = createScheduler({ repo, runner, now, tickMs: 1000, computeNextRun: () => NOW + 1000 });

    await scheduler.tick();
    await flush();
    expect(runner.startTaskRun).toHaveBeenCalledTimes(1);
    expect(scheduler.state().inFlight).toEqual(['t1']);

    await scheduler.tick();
    await flush();
    expect(runner.startTaskRun).toHaveBeenCalledTimes(1);

    pending.resolve({
      run: { id: 'run-1', task_id: 't1', status: 'success', finished_at: new Date(NOW).toISOString() },
      status: 'success',
      sessionId: null,
      output: null,
      error: null,
    });
    await scheduler.whenIdle();

    expect(scheduler.state().inFlight).toEqual([]);
    expect(repo.advanceTask).toHaveBeenCalledTimes(2);
  });

  it('reports not_found when running an unknown task', async () => {
    const repo = makeRepo([]);
    const runner = makeRunner();
    const scheduler = createScheduler({ repo, runner, now, tickMs: 1000, computeNextRun: () => NOW });

    await expect(scheduler.runNow('missing')).resolves.toEqual({ error: 'not_found' });
    expect(runner.startTaskRun).not.toHaveBeenCalled();
  });

  it('starts a manual run without shifting nextRunAt', async () => {
    const task = makeTask();
    const repo = makeRepo([task]);
    const runner = makeRunner();
    const scheduler = createScheduler({ repo, runner, now, tickMs: 1000, computeNextRun: () => NOW + 60000 });

    const result = await scheduler.runNow('t1');

    expect(result.run.status).toBe('running');
    expect(runner.startTaskRun).toHaveBeenCalledWith(task, { trigger: 'manual', scheduledFor: null });

    await scheduler.whenIdle();

    expect(repo.advanceTask).toHaveBeenCalledTimes(1);
    expect(repo.advanceTask.mock.calls[0][1]).toMatchObject({
      nextRunAt: task.next_run_at,
      lastStatus: 'success',
      runCount: 1,
    });
  });

  it('rejects a manual run while the task is already in flight', async () => {
    const task = makeTask();
    const repo = makeRepo([task]);
    const pending = deferred();
    const runner = makeRunner(() => pending.promise);
    const scheduler = createScheduler({ repo, runner, now, tickMs: 1000, computeNextRun: () => NOW + 60000 });

    await scheduler.runNow('t1');
    await expect(scheduler.runNow('t1')).resolves.toEqual({ error: 'in_flight' });
    expect(runner.startTaskRun).toHaveBeenCalledTimes(1);

    pending.resolve({ run: { id: 'run-1', status: 'success' }, status: 'success', sessionId: null, output: null, error: null });
    await scheduler.whenIdle();
  });

  it('ticks immediately on start and keeps rescheduling until stopped', async () => {
    vi.useFakeTimers();
    const repo = makeRepo([]);
    const runner = makeRunner();
    const scheduler = createScheduler({ repo, runner, now: () => Date.now(), tickMs: 1000, computeNextRun: () => null });

    scheduler.start();
    expect(scheduler.state()).toEqual({ running: true, tickMs: 1000, inFlight: [] });

    await vi.advanceTimersByTimeAsync(0);
    expect(repo.listDueTasks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.listDueTasks).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.listDueTasks).toHaveBeenCalledTimes(3);

    scheduler.stop();
    expect(scheduler.state().running).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(repo.listDueTasks).toHaveBeenCalledTimes(3);
  });

  it('does nothing on a tick when SCHEDULED_TASKS_ENABLED is off', async () => {
    process.env.SCHEDULED_TASKS_ENABLED = '0';
    const repo = makeRepo([makeTask()]);
    const runner = makeRunner();
    const scheduler = createScheduler({ repo, runner, now, tickMs: 1000, computeNextRun: () => NOW + 1000 });

    await scheduler.tick();

    expect(repo.listDueTasks).not.toHaveBeenCalled();
    expect(runner.startTaskRun).not.toHaveBeenCalled();
  });

  it('passes the configured tick interval through state()', () => {
    process.env.SCHEDULED_TASKS_TICK_MS = '1234';
    const scheduler = createScheduler({ repo: makeRepo([]), runner: makeRunner() });
    expect(scheduler.state().tickMs).toBe(1234);
  });
});

describe('getSchedulerState', () => {
  it('returns an idle state before the service is started', () => {
    const state = getSchedulerState();
    expect(state.running).toBe(false);
    expect(state.inFlight).toEqual([]);
    expect(typeof state.tickMs).toBe('number');
  });
});
