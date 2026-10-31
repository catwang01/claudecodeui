import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../modules/database/index.js', () => ({
  scheduledTasksDb: {
    createRun: vi.fn(),
    finishRun: vi.fn(),
    attachRunSession: vi.fn(),
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
import { runDir, taskDir, workspacePromptBlock } from './workspace.js';
import { PREDEFINED_ENV_NAMES, predefinedVarsPromptBlock } from './params.js';

let dataDir;

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
  delete process.env.SCHEDULED_TASKS_WORKSPACE;
  delete process.env.SCHEDULED_TASK_KEEP_RUN_TMP;

  // §10.4 workspace: never write into the developer's home directory.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-runner-ws-'));
  process.env.SCHEDULED_TASK_DATA_DIR = dataDir;

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
    params_json: input.paramsJson ?? null,
  }));
  scheduledTasksDb.attachRunSession.mockReset().mockReturnValue({});
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
  delete process.env.SCHEDULED_TASKS_WORKSPACE;
  delete process.env.SCHEDULED_TASK_KEEP_RUN_TMP;
  delete process.env.SCHEDULED_TASK_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
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
      expect.stringContaining('do stuff'),
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
    // The session must be linked while the run is still in flight, not only at finish.
    expect(scheduledTasksDb.attachRunSession).toHaveBeenCalledWith('run-1', 'sess-1');
    expect(scheduledTasksDb.attachRunSession.mock.invocationCallOrder[0]).toBeLessThan(
      scheduledTasksDb.finishRun.mock.invocationCallOrder[0]
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
      expect.stringContaining('do the thing'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.anything()
    );
  });

  it('falls back to the static prompt for { skip: false } with no prompt', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const result = await runWith({ command: emit('{"skip":false}') });

    expect(result.status).toBe('success');
    expect(result.promptUsed).toBe('do stuff');
    expect(queryClaudeSDK).toHaveBeenCalledWith(
      expect.stringContaining('do stuff'),
      expect.anything(),
      expect.anything()
    );
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
    expect(queryClaudeSDK).toHaveBeenCalledWith(
      expect.stringContaining('do stuff'),
      expect.anything(),
      expect.anything()
    );
  });
});

describe('workspace (§10.4)', () => {
  const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

  it('creates the task and run layout on a dry run and keeps promptUsed unchanged', async () => {
    process.env.SCHEDULED_TASK_DRY_RUN = '1';

    const result = await startTaskRun(makeTask()).done;

    expect(result.status).toBe('success');
    expect(result.output).toBe('[dry-run] do stuff');
    expect(result.promptUsed).toBe('do stuff');
    expect(queryClaudeSDK).not.toHaveBeenCalled();

    expect(fs.existsSync(path.join(taskDir('t1'), 'task.json'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir('t1'), 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir('t1'), 'prompt.md'))).toBe(true);
    expect(fs.readFileSync(path.join(taskDir('t1'), 'prompt.md'), 'utf8')).toBe('do stuff');
    // §10.4: the framework creates no state/ or tmp/ — the root is the task's.
    expect(fs.existsSync(path.join(taskDir('t1'), 'state'))).toBe(false);
    expect(fs.existsSync(path.join(taskDir('t1'), 'tmp'))).toBe(false);

    const dir = runDir('t1', 'run-1');
    expect(readJson(path.join(dir, 'run.json')).status).toBe('success');
    expect(fs.readFileSync(path.join(dir, 'output.md'), 'utf8')).toBe('[dry-run] do stuff');
    expect(fs.statSync(path.join(dir, 'logs')).isDirectory()).toBe(true);
    // The framework never creates a per-run tmp/ either.
    expect(fs.existsSync(path.join(dir, 'tmp'))).toBe(false);
  });

  it('prepends the workspace block to the agent prompt but keeps promptUsed effective', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const result = await startTaskRun(makeTask()).done;

    const block = workspacePromptBlock(makeTask(), { runId: 'run-1' });
    const builtinBlock = predefinedVarsPromptBlock();
    const expectedPrompt = `${block}\n\n${builtinBlock}\n\ndo stuff`;
    expect(queryClaudeSDK).toHaveBeenCalledWith(
      expectedPrompt,
      expect.objectContaining({ cwd: '/tmp/scheduled-project', permissionMode: 'bypassPermissions' }),
      expect.anything()
    );
    expect(result.promptUsed).toBe('do stuff');
    expect(fs.readFileSync(path.join(runDir('t1', 'run-1'), 'prompt.md'), 'utf8')).toBe(
      expectedPrompt
    );

    const record = readJson(path.join(runDir('t1', 'run-1'), 'run.json'));
    expect(record.status).toBe('success');
    expect(record.taskId).toBe('t1');
    expect(record.workspace).toEqual({
      root: path.resolve(dataDir),
      taskDir: taskDir('t1'),
      runDir: runDir('t1', 'run-1'),
    });
  });

  it('uses the gate prompt for the agent prompt, prompt.md and promptUsed', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-runner-gate-'));
    queryClaudeSDK.mockResolvedValue(undefined);

    try {
      const emit = (text) => "printf '%s' '" + text + "'";
      const result = await startTaskRun(
        makeTask({ project_path: projectDir, command: emit('{"prompt":"gated prompt"}') })
      ).done;

      const block = workspacePromptBlock(makeTask({ project_path: projectDir }), { runId: 'run-1' });
      const expectedPrompt = `${block}\n\n${predefinedVarsPromptBlock()}\n\ngated prompt`;
      expect(result.promptUsed).toBe('gated prompt');
      expect(queryClaudeSDK).toHaveBeenCalledWith(
        expectedPrompt,
        expect.anything(),
        expect.anything()
      );
      const dir = runDir('t1', 'run-1');
      expect(fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8')).toBe(expectedPrompt);
      // Script-gate stdout is kept under logs/.
      expect(fs.readFileSync(path.join(dir, 'logs', 'gate-stdout.log'), 'utf8')).toBe(
        '{"prompt":"gated prompt"}'
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('gives the script gate the SCHEDULED_TASK_* workspace variables', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-runner-env-'));
    queryClaudeSDK.mockResolvedValue(undefined);

    try {
      const envEcho =
        "printf '{\"prompt\":\"%s|%s|%s\"}' \"$SCHEDULED_TASK_DIR\" \"$SCHEDULED_TASK_RUN_ID\" \"$SCHEDULED_TASK_RUN_DIR\"";
      const result = await startTaskRun(makeTask({ project_path: projectDir, command: envEcho })).done;

      expect(result.status).toBe('success');
      expect(result.promptUsed).toBe([taskDir('t1'), 'run-1', runDir('t1', 'run-1')].join('|'));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('records a failed run in run.json and output.md', async () => {
    queryClaudeSDK.mockRejectedValue(new Error('boom'));

    const result = await startTaskRun(makeTask()).done;

    expect(result.status).toBe('error');
    const dir = runDir('t1', 'run-1');
    expect(readJson(path.join(dir, 'run.json')).status).toBe('error');
    expect(readJson(path.join(dir, 'run.json')).error).toBe('boom');
    expect(fs.readFileSync(path.join(dir, 'output.md'), 'utf8')).toBe('boom');
  });

  it('creates no state/ or tmp/ dir for the task (the root belongs to the task)', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    await startTaskRun(makeTask()).done;

    expect(fs.existsSync(path.join(taskDir('t1'), 'state'))).toBe(false);
    expect(fs.existsSync(path.join(taskDir('t1'), 'tmp'))).toBe(false);
    expect(fs.existsSync(path.join(runDir('t1', 'run-1'), 'tmp'))).toBe(false);
  });

  it('creates nothing and leaves the prompt untouched when the workspace is disabled', async () => {
    process.env.SCHEDULED_TASKS_WORKSPACE = '0';
    queryClaudeSDK.mockResolvedValue(undefined);

    const result = await startTaskRun(makeTask()).done;

    expect(result.promptUsed).toBe('do stuff');
    // §13.5: with no workspace the block drops the workspace group.
    expect(queryClaudeSDK).toHaveBeenCalledWith(
      `${predefinedVarsPromptBlock({ includeWorkspace: false })}\n\ndo stuff`,
      expect.anything(),
      expect.anything()
    );
    const [, options] = queryClaudeSDK.mock.calls[0];
    expect(Object.keys(options.env).sort()).toEqual([
      'SCHEDULED_TASK_CWD',
      'SCHEDULED_TASK_ID',
      'SCHEDULED_TASK_PROJECT',
      'SCHEDULED_TASK_TITLE',
    ]);
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });
});


describe('parameters (§12)', () => {
  const DEFS = JSON.stringify([
    { name: 'region', type: 'string', default: 'eu' },
    { name: 'threshold', type: 'number', default: 3 },
    { name: 'dryRun', type: 'boolean', default: false },
  ]);
  const RESOLVED = '{"region":"eu","threshold":3,"dryRun":false}';

  it('stores the resolved values on the run row and in run.json', async () => {
    process.env.SCHEDULED_TASK_DRY_RUN = '1';

    const result = await startTaskRun(makeTask({ params_json: DEFS })).done;

    expect(result.status).toBe('success');
    expect(scheduledTasksDb.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ paramsJson: RESOLVED })
    );
    const record = JSON.parse(
      fs.readFileSync(path.join(runDir('t1', 'run-1'), 'run.json'), 'utf8')
    );
    expect(record.params).toEqual({ region: 'eu', threshold: 3, dryRun: false });
  });

  it('exports the parameters to the script gate after the workspace variables', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-runner-params-'));
    queryClaudeSDK.mockResolvedValue(undefined);

    try {
      // The gate cannot echo SCHEDULED_TASK_PARAMS inside its JSON envelope (the
      // value's own quotes would break it), so it writes the values to disk.
      const command =
        'printf "%s" "$SCHEDULED_TASK_PARAM_REGION|$SCHEDULED_TASK_PARAM_THRESHOLD|$SCHEDULED_TASK_PARAM_DRYRUN" > "$SCHEDULED_TASK_RUN_DIR/params.txt"; ' +
        'printf "%s" "$SCHEDULED_TASK_PARAMS" > "$SCHEDULED_TASK_RUN_DIR/params.json"; ' +
        'printf \'{"skip":true,"reason":"gated"}\'';
      const result = await startTaskRun(
        makeTask({ project_path: projectDir, params_json: DEFS, command })
      ).done;

      expect(result.status).toBe('skipped');
      expect(fs.readFileSync(path.join(runDir('t1', 'run-1'), 'params.txt'), 'utf8')).toBe('eu|3|false');
      expect(fs.readFileSync(path.join(runDir('t1', 'run-1'), 'params.json'), 'utf8')).toBe(RESOLVED);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('passes options.env to the agent and prefixes the Parameters block', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const result = await startTaskRun(makeTask({ params_json: DEFS })).done;

    const [prompt, options] = queryClaudeSDK.mock.calls[0];
    expect(options.env).toEqual({
      SCHEDULED_TASK_ID: 't1',
      SCHEDULED_TASK_TITLE: 'Nightly docs',
      SCHEDULED_TASK_CWD: '/tmp/scheduled-project',
      SCHEDULED_TASK_PROJECT: '/tmp/scheduled-project',
      SCHEDULED_TASK_DIR: taskDir('t1'),
      SCHEDULED_TASK_RUN_ID: 'run-1',
      SCHEDULED_TASK_RUN_DIR: runDir('t1', 'run-1'),
      SCHEDULED_TASK_PARAM_REGION: 'eu',
      SCHEDULED_TASK_PARAM_THRESHOLD: '3',
      SCHEDULED_TASK_PARAM_DRYRUN: 'false',
      SCHEDULED_TASK_PARAMS: RESOLVED,
    });
    expect(prompt).toContain('## Scheduled task parameters');
    expect(prompt).toContain('$SCHEDULED_TASK_PARAM_REGION');
    expect(prompt).toContain('do stuff');
    expect(result.promptUsed).toBe('do stuff');

    const promptFile = fs.readFileSync(path.join(runDir('t1', 'run-1'), 'prompt.md'), 'utf8');
    expect(promptFile).toContain('## Scheduled task parameters');
  });

  it('lets a per-run override win over the default and coerces it', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    await startTaskRun(makeTask({ params_json: DEFS }), { params: { threshold: '9', dryrun: 'true' } })
      .done;

    const [, options] = queryClaudeSDK.mock.calls[0];
    expect(options.env.SCHEDULED_TASK_PARAM_THRESHOLD).toBe('9');
    expect(options.env.SCHEDULED_TASK_PARAM_DRYRUN).toBe('true');
    expect(scheduledTasksDb.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ paramsJson: '{"region":"eu","threshold":9,"dryRun":true}' })
    );
  });

  it('fails a missing required parameter without a gate or agent call', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-runner-required-'));
    const spawn = vi.fn();
    const runner = createTaskRunner({
      scheduledTasksDb,
      queryClaudeSDK,
      addProjectManually,
      abortClaudeSDKSession,
      spawn,
    });

    try {
      const result = await runner.startTaskRun(
        makeTask({
          project_path: projectDir,
          params_json: '[{"name":"token","type":"string","required":true}]',
          command: 'echo hi',
        })
      ).done;

      expect(result.status).toBe('error');
      expect(result.error).toBe('missing_required_param');
      expect(spawn).not.toHaveBeenCalled();
      expect(queryClaudeSDK).not.toHaveBeenCalled();
      expect(scheduledTasksDb.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ paramsJson: null })
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('leaves the no-params namespace untouched and still exports the built-ins', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    await startTaskRun(makeTask()).done;

    const [prompt, options] = queryClaudeSDK.mock.calls[0];
    // §13.4: no SCHEDULED_TASK_PARAM_* / SCHEDULED_TASK_PARAMS, but every
    // predefined variable is exported to the agent on every run (§13.3).
    expect(options.env).toEqual({
      SCHEDULED_TASK_ID: 't1',
      SCHEDULED_TASK_TITLE: 'Nightly docs',
      SCHEDULED_TASK_CWD: '/tmp/scheduled-project',
      SCHEDULED_TASK_PROJECT: '/tmp/scheduled-project',
      SCHEDULED_TASK_DIR: taskDir('t1'),
      SCHEDULED_TASK_RUN_ID: 'run-1',
      SCHEDULED_TASK_RUN_DIR: runDir('t1', 'run-1'),
    });
    expect(prompt).toContain('## Predefined scheduled-task variables');
    expect(prompt).not.toContain('Scheduled task parameters');
    expect(scheduledTasksDb.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ paramsJson: null })
    );
  });
});

describe('built-in parameters (§13)', () => {
  it('exports the built-ins to the script gate of a zero-parameter task', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-runner-builtin-'));

    try {
      const command =
        'printf "%s" "$SCHEDULED_TASK_TITLE|$SCHEDULED_TASK_CWD|$SCHEDULED_TASK_PROJECT" > "$SCHEDULED_TASK_RUN_DIR/builtins.txt"; ' +
        'printf \'{"skip":true,"reason":"gated"}\'';
      const result = await startTaskRun(makeTask({ project_path: projectDir, command })).done;

      expect(result.status).toBe('skipped');
      expect(fs.readFileSync(path.join(runDir('t1', 'run-1'), 'builtins.txt'), 'utf8')).toBe(
        'Nightly docs|' + projectDir + '|' + projectDir
      );
      expect(queryClaudeSDK).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('hands the script gate and the agent identical workspace values for one run', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-runner-same-'));

    try {
      const command =
        'printf "%s" "$SCHEDULED_TASK_DIR|$SCHEDULED_TASK_RUN_ID|$SCHEDULED_TASK_RUN_DIR" > "$SCHEDULED_TASK_RUN_DIR/gate-workspace.txt"; ' +
        'printf \'{"prompt":"gated prompt"}\'';
      await startTaskRun(makeTask({ project_path: projectDir, command })).done;

      const gate = fs
        .readFileSync(path.join(runDir('t1', 'run-1'), 'gate-workspace.txt'), 'utf8')
        .split('|');
      const [, options] = queryClaudeSDK.mock.calls[0];
      // §13.3: one predefinedVarsEnv() object feeds both environments, so the
      // gate and the agent must agree byte for byte on the same runId.
      expect(gate).toEqual([
        options.env.SCHEDULED_TASK_DIR,
        options.env.SCHEDULED_TASK_RUN_ID,
        options.env.SCHEDULED_TASK_RUN_DIR,
      ]);
      expect(options.env.SCHEDULED_TASK_RUN_ID).toBe('run-1');
      expect(options.env.SCHEDULED_TASK_RUN_DIR).toBe(runDir('t1', 'run-1'));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('lists the built-ins in the agent prompt and carries the no-hardcode instruction', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    await startTaskRun(makeTask()).done;

    const [prompt] = queryClaudeSDK.mock.calls[0];
    expect(prompt).toContain('## Predefined scheduled-task variables');
    // §13.5: every predefined variable is named, with the root/id note.
    for (const envName of PREDEFINED_ENV_NAMES) {
      expect(prompt).toContain('$' + envName);
    }
    expect(prompt).toContain('belongs to the task');
    expect(prompt).toMatch(/never hardcode/i);
    expect(prompt).toContain('NOT a chat session id');
    expect(prompt).toContain('run history');
    expect(prompt).toContain('## Scheduled task workspace');
  });

  it('never lets a declared parameter replace a built-in (gate and agent)', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);
    const shadowDefs = JSON.stringify([{ name: 'title', type: 'string', default: 'shadow' }]);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-runner-shadow-'));

    try {
      const gateCommand =
        'printf "%s" "$SCHEDULED_TASK_TITLE|$SCHEDULED_TASK_PARAM_TITLE" > "$SCHEDULED_TASK_RUN_DIR/shadow.txt"; ' +
        'printf \'{"skip":true,"reason":"gated"}\'';
      const gated = await startTaskRun(
        makeTask({ project_path: projectDir, params_json: shadowDefs, command: gateCommand })
      ).done;
      expect(gated.status).toBe('skipped');
      expect(fs.readFileSync(path.join(runDir('t1', 'run-1'), 'shadow.txt'), 'utf8')).toBe(
        'Nightly docs|shadow'
      );

      await startTaskRun(makeTask({ project_path: projectDir, params_json: shadowDefs })).done;
      const [, options] = queryClaudeSDK.mock.calls[0];
      expect(options.env.SCHEDULED_TASK_TITLE).toBe('Nightly docs');
      expect(options.env.SCHEDULED_TASK_PARAM_TITLE).toBe('shadow');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects a per-run override that targets a built-in', async () => {
    queryClaudeSDK.mockResolvedValue(undefined);

    const result = await startTaskRun(makeTask(), { params: { TITLE: 'hijack' } }).done;

    expect(result.status).toBe('error');
    expect(result.error).toBe('invalid_input');
    expect(queryClaudeSDK).not.toHaveBeenCalled();
  });
});

