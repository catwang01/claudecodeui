import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../modules/database/index.js', () => ({
  scheduledTasksDb: {
    createRun: vi.fn(),
    finishRun: vi.fn(),
  },
}));

vi.mock('../projects.js', () => ({
  addProjectManually: vi.fn(),
}));

vi.mock('../claude-sdk.js', () => ({
  queryClaudeSDK: vi.fn(),
  abortClaudeSDKSession: vi.fn(),
}));

import { scheduledTasksDb } from '../modules/database/index.js';
import { addProjectManually } from '../projects.js';
import { queryClaudeSDK, abortClaudeSDKSession } from '../claude-sdk.js';
import { startTaskRun } from './runner.js';

function makeTask(overrides = {}) {
  return {
    id: 't1',
    user_id: 7,
    title: 'Nightly docs',
    prompt: 'do stuff',
    project_path: '/tmp/scheduled-project',
    provider: 'claude',
    model: null,
    kind: 'interval',
    rule_json: JSON.stringify({ kind: 'interval', everySeconds: 60 }),
    next_run_at: '2026-01-01T00:00:00.000Z',
    last_run_at: null,
    last_status: null,
    last_error: null,
    enabled: 1,
    run_count: 0,
    created_at: '2025-12-31T00:00:00.000Z',
    updated_at: '2025-12-31T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.SCHEDULED_TASK_DRY_RUN;
  delete process.env.SCHEDULED_TASK_TIMEOUT_MS;

  scheduledTasksDb.createRun.mockReset().mockImplementation((input) => ({
    id: 'run-1',
    task_id: input.taskId,
    status: 'running',
    trigger: input.trigger,
    scheduled_for: input.scheduledFor ?? null,
    started_at: input.startedAt,
    finished_at: null,
    session_id: null,
    output: null,
    error: null,
  }));
  scheduledTasksDb.finishRun.mockReset().mockImplementation((id, patch) => ({
    id,
    task_id: 't1',
    ...patch,
  }));
  addProjectManually.mockReset().mockResolvedValue(true);
  queryClaudeSDK.mockReset();
  abortClaudeSDKSession.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.SCHEDULED_TASK_DRY_RUN;
  delete process.env.SCHEDULED_TASK_TIMEOUT_MS;
});

describe('startTaskRun', () => {
  it('creates the running run row synchronously', () => {
    queryClaudeSDK.mockImplementation(() => new Promise(() => {}));

    const { run } = startTaskRun(makeTask());

    expect(run.status).toBe('running');
    expect(run.trigger).toBe('schedule');
    expect(scheduledTasksDb.createRun).toHaveBeenCalledTimes(1);
    expect(scheduledTasksDb.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 't1',
        status: 'running',
        trigger: 'schedule',
        scheduledFor: null,
      })
    );
  });

  it('collects session id and assistant text on a successful run', async () => {
    queryClaudeSDK.mockImplementation(async (command, options, writer) => {
      writer.send({ kind: 'session_created', sessionId: 'sess-1' });
      writer.send({ kind: 'text', role: 'assistant', content: 'hello' });
      writer.send({ kind: 'text', role: 'assistant', content: 'world' });
      writer.send({ kind: 'complete', exitCode: 0 });
    });

    const { done } = startTaskRun(makeTask());
    const result = await done;

    expect(result.status).toBe('success');
    expect(result.sessionId).toBe('sess-1');
    expect(result.output).toBe('hello\nworld');
    expect(result.error).toBeNull();
    expect(queryClaudeSDK).toHaveBeenCalledTimes(1);
    expect(queryClaudeSDK).toHaveBeenCalledWith(
      'do stuff',
      expect.objectContaining({
        cwd: '/tmp/scheduled-project',
        // Unattended runs must never wait for a browser approval.
        permissionMode: 'bypassPermissions',
      }),
      expect.objectContaining({ userId: 7 })
    );
    expect(scheduledTasksDb.finishRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'success', sessionId: 'sess-1', output: 'hello\nworld', error: null })
    );
    expect(addProjectManually).toHaveBeenCalledWith('/tmp/scheduled-project');
  });

  it('reports a thrown error as an error run and never rejects', async () => {
    queryClaudeSDK.mockRejectedValue(new Error('boom'));

    const { done } = startTaskRun(makeTask());
    const result = await done;

    expect(result.status).toBe('error');
    expect(result.error).toBe('boom');
    expect(scheduledTasksDb.finishRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'error', error: 'boom' })
    );
  });

  it('treats a streamed error message as an error run', async () => {
    queryClaudeSDK.mockImplementation(async (_command, _options, writer) => {
      writer.send({ kind: 'session_created', sessionId: 'sess-2' });
      writer.send({ kind: 'error', content: 'agent gave up' });
    });

    const result = await startTaskRun(makeTask()).done;

    expect(result.status).toBe('error');
    expect(result.error).toBe('agent gave up');
    expect(result.sessionId).toBe('sess-2');
  });

  it('produces an error run for unsupported providers without querying the agent', async () => {
    const { done } = startTaskRun(makeTask({ provider: 'gemini' }));
    const result = await done;

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Unsupported provider: gemini/);
    expect(queryClaudeSDK).not.toHaveBeenCalled();
  });

  it('times out, aborts the session and finishes as an error run', async () => {
    process.env.SCHEDULED_TASK_TIMEOUT_MS = '25';
    queryClaudeSDK.mockImplementation((_command, _options, writer) => {
      writer.send({ kind: 'session_created', sessionId: 'sess-timeout' });
      // Never resolves: simulates a hung agent.
      return new Promise(() => {});
    });

    const { done } = startTaskRun(makeTask());
    const result = await done;

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/timed out after 25ms/);
    expect(abortClaudeSDKSession).toHaveBeenCalledWith('sess-timeout');
    expect(scheduledTasksDb.finishRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'error' })
    );
  });

  it('dry run finishes as success without calling the agent', async () => {
    process.env.SCHEDULED_TASK_DRY_RUN = '1';

    const { done } = startTaskRun(makeTask());
    const result = await done;

    expect(result.status).toBe('success');
    expect(result.sessionId).toBeNull();
    expect(result.output).toBe('[dry-run] do stuff');
    expect(result.error).toBeNull();
    expect(queryClaudeSDK).not.toHaveBeenCalled();
    expect(scheduledTasksDb.createRun).toHaveBeenCalledTimes(1);
    expect(scheduledTasksDb.finishRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'success', output: '[dry-run] do stuff', sessionId: null })
    );
  });

  it('passes the manual trigger through to the run row', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const task = makeTask();
    const { run, done } = startTaskRun(task, { trigger: 'manual' });
    await done;

    expect(run.trigger).toBe('manual');
    expect(scheduledTasksDb.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'manual', scheduledFor: null })
    );
  });
});
