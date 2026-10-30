import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
import { createTaskRunner, startTaskRun } from './runner.js';

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
  delete process.env.SCHEDULED_TASKS_COMMANDS;

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
  delete process.env.SCHEDULED_TASKS_COMMANDS;
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

describe('script gate (§7)', () => {
  // The gate spawns with cwd = projectPath, so use a directory that really exists.
  const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-gate-'));
  const emit = (text) => "printf '%s' '" + text + "'";

  afterAll(() => {
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  });

  async function runWith(overrides, options) {
    const { done } = startTaskRun(makeTask({ project_path: PROJECT_DIR, ...overrides }), options);
    return done;
  }

  it('skips the run when the envelope says skip:true', async () => {
    const result = await runWith({ command: emit('{"skip":true,"reason":"nothing to do"}') });

    expect(result.status).toBe('skipped');
    expect(result.output).toBe('nothing to do');
    expect(result.promptUsed).toBeNull();
    expect(result.scriptExitCode).toBe(0);
    expect(result.scriptOutput).toBe('{"skip":true,"reason":"nothing to do"}');
    expect(queryClaudeSDK).not.toHaveBeenCalled();
    expect(scheduledTasksDb.finishRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'skipped',
        output: 'nothing to do',
        promptUsed: null,
        scriptExitCode: 0,
        scriptOutput: '{"skip":true,"reason":"nothing to do"}',
      })
    );
  });

  it('runs the agent with the envelope prompt when one is provided', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const result = await runWith({ command: emit('{"prompt":"do the thing"}') });

    expect(result.status).toBe('success');
    expect(result.promptUsed).toBe('do the thing');
    expect(queryClaudeSDK).toHaveBeenCalledWith(
      'do the thing',
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.anything()
    );
  });

  it('falls back to the static prompt for { skip: false } with no prompt', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const result = await runWith({ command: emit('{"skip":false}') });

    expect(result.status).toBe('success');
    expect(result.promptUsed).toBe('do stuff');
    expect(queryClaudeSDK).toHaveBeenCalledWith('do stuff', expect.anything(), expect.anything());
  });

  it('accepts JSON on the last non-empty line when there is noise before it', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const result = await runWith({ command: emit('noise\nnot json\n{"prompt":"from last line"}') });

    expect(result.status).toBe('success');
    expect(result.promptUsed).toBe('from last line');
  });

  it('rejects an empty object envelope', async () => {
    const result = await runWith({ command: emit('{}') });

    expect(result.status).toBe('error');
    expect(result.error).toBe('invalid_script_output');
    expect(queryClaudeSDK).not.toHaveBeenCalled();
  });

  it('rejects an envelope with neither prompt nor boolean skip', async () => {
    expect((await runWith({ command: emit('{"reason":"x"}') })).error).toBe('invalid_script_output');
  });

  it('rejects a non-boolean skip', async () => {
    expect((await runWith({ command: emit('{"skip":"yes"}') })).error).toBe('invalid_script_output');
  });

  it('rejects invalid JSON', async () => {
    expect((await runWith({ command: emit('not json at all') })).error).toBe('invalid_script_output');
  });

  it('rejects a non-object JSON payload', async () => {
    expect((await runWith({ command: emit('[1,2]') })).error).toBe('invalid_script_output');
  });

  it('rejects a successful command that prints nothing', async () => {
    const result = await runWith({ command: 'true' });

    expect(result.status).toBe('error');
    expect(result.error).toBe('invalid_script_output');
    expect(result.scriptExitCode).toBe(0);
    expect(result.scriptOutput).toBe('');
    expect(queryClaudeSDK).not.toHaveBeenCalled();
  });

  it('records script_exit_<code> on a non-zero exit and never calls the agent', async () => {
    const result = await runWith({ command: "printf 'partial'; exit 3" });

    expect(result.status).toBe('error');
    expect(result.error).toBe('script_exit_3');
    expect(result.scriptExitCode).toBe(3);
    expect(result.scriptOutput).toBe('partial');
    expect(queryClaudeSDK).not.toHaveBeenCalled();
  });

  it('kills the command group and records script_timeout', async () => {
    const started = Date.now();
    const result = await runWith({ command: 'sleep 5', command_timeout_seconds: 1 });

    expect(result.status).toBe('error');
    expect(result.error).toBe('script_timeout');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(queryClaudeSDK).not.toHaveBeenCalled();
  });

  it('falls back to the default timeout for an out-of-range value', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const result = await runWith({ command: emit('{"skip":false}'), command_timeout_seconds: 0 });

    expect(result.status).toBe('success');
  });

  it('refuses to execute a command when SCHEDULED_TASKS_COMMANDS=0', async () => {
    process.env.SCHEDULED_TASKS_COMMANDS = '0';

    const result = await runWith({ command: emit('{"skip":true}') });

    expect(result.status).toBe('error');
    expect(result.error).toBe('commands_disabled');
    expect(result.promptUsed).toBeNull();
    expect(queryClaudeSDK).not.toHaveBeenCalled();
  });

  it('truncates script output to 20000 characters', async () => {
    const result = await runWith({ command: 'yes a | head -c 25000' });

    expect(result.error).toBe('invalid_script_output');
    expect(result.scriptOutput).toHaveLength(20000);
  });

  it('passes SCHEDULED_TASK_ID/TITLE/PROJECT into the command environment', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const envEcho = "printf '{\"prompt\":\"%s|%s|%s\"}' \"$SCHEDULED_TASK_ID\" \"$SCHEDULED_TASK_TITLE\" \"$SCHEDULED_TASK_PROJECT\"";
    const result = await runWith({ command: envEcho });

    expect(result.status).toBe('success');
    expect(result.promptUsed).toBe('t1|Nightly docs|' + PROJECT_DIR);
  });

  it('does not short-circuit the gate under SCHEDULED_TASK_DRY_RUN', async () => {
    process.env.SCHEDULED_TASK_DRY_RUN = '1';

    const skipped = await runWith({ command: emit('{"skip":true,"reason":"gated off"}') });
    expect(skipped.status).toBe('skipped');
    expect(skipped.output).toBe('gated off');
    expect(skipped.promptUsed).toBeNull();

    const overridden = await runWith({ command: emit('{"prompt":"dry prompt"}') });
    expect(overridden.status).toBe('success');
    expect(overridden.output).toBe('[dry-run] dry prompt');
    expect(overridden.promptUsed).toBe('dry prompt');

    expect(queryClaudeSDK).not.toHaveBeenCalled();
  });

  it('leaves the no-command path unchanged (no spawn, static prompt used)', async () => {
    const spawn = vi.fn();
    const runner = createTaskRunner({
      scheduledTasksDb,
      queryClaudeSDK,
      addProjectManually,
      abortClaudeSDKSession,
      spawn,
    });
    queryClaudeSDK.mockResolvedValue(undefined);

    const { done } = runner.startTaskRun(makeTask());
    const result = await done;

    expect(result.status).toBe('success');
    expect(result.promptUsed).toBe('do stuff');
    expect(result.scriptOutput).toBeNull();
    expect(result.scriptExitCode).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(queryClaudeSDK).toHaveBeenCalledWith('do stuff', expect.anything(), expect.anything());
  });
});
