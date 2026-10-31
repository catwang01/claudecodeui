import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SCHEDULED_TASK_SCHEMA_VERSION,
  ensureRunWorkspace,
  ensureTaskWorkspace,
  finalizeRunWorkspace,
  isWorkspaceEnabled,
  runDir,
  taskDir,
  taskRunsDir,
  tasksRoot,
  workspaceEnv,
  workspacePromptBlock,
} from './workspace.js';

const ENV_KEYS = ['SCHEDULED_TASK_DATA_DIR', 'SCHEDULED_TASKS_WORKSPACE'];

let dataDir;

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    user_id: 7,
    title: 'Nightly docs',
    prompt: 'do stuff',
    project_path: '/tmp/scheduled-project',
    provider: 'claude',
    model: 'sonnet',
    kind: 'interval',
    rule_json: JSON.stringify({ kind: 'interval', everySeconds: 60, anchorMs: 1 }),
    command: 'echo hi',
    command_timeout_seconds: 30,
    enabled: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    task_id: 'task-1',
    status: 'running',
    trigger: 'schedule',
    scheduled_for: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:01.000Z',
    finished_at: null,
    session_id: null,
    output: null,
    error: null,
    ...overrides,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-ws-'));
  process.env.SCHEDULED_TASK_DATA_DIR = dataDir;
  delete process.env.SCHEDULED_TASKS_WORKSPACE;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('root and path helpers', () => {
  it('uses SCHEDULED_TASK_DATA_DIR as the root', () => {
    expect(tasksRoot()).toBe(path.resolve(dataDir));
  });

  it('falls back to ~/.claudecodeui/scheduled-tasks', () => {
    delete process.env.SCHEDULED_TASK_DATA_DIR;
    expect(tasksRoot()).toBe(path.join(os.homedir(), '.claudecodeui', 'scheduled-tasks'));
  });

  it('builds the documented layout (one task root + the run dirs)', () => {
    expect(taskDir('task-1')).toBe(path.join(path.resolve(dataDir), 'task-1'));
    expect(taskRunsDir('task-1')).toBe(path.join(taskDir('task-1'), 'runs'));
    expect(runDir('task-1', 'run-1')).toBe(path.join(taskRunsDir('task-1'), 'run-1'));
  });

  it('refuses path segments that would escape the root', () => {
    expect(taskDir('../evil')).toBeNull();
    expect(taskDir('a/b')).toBeNull();
    expect(taskDir('')).toBeNull();
    expect(taskDir(null)).toBeNull();
    expect(runDir('task-1', '../evil')).toBeNull();
    expect(runDir('task-1', null)).toBeNull();
  });
});

describe('isWorkspaceEnabled', () => {
  it('is on by default and accepts the usual off values', () => {
    expect(isWorkspaceEnabled()).toBe(true);
    for (const value of ['0', 'false', 'off', 'no', 'OFF']) {
      process.env.SCHEDULED_TASKS_WORKSPACE = value;
      expect(isWorkspaceEnabled()).toBe(false);
    }
    process.env.SCHEDULED_TASKS_WORKSPACE = '1';
    expect(isWorkspaceEnabled()).toBe(true);
  });

  it('turns every function into a no-op returning null and creates nothing', () => {
    process.env.SCHEDULED_TASKS_WORKSPACE = '0';
    const task = makeTask();
    const run = makeRun();

    expect(tasksRoot()).toBeNull();
    expect(taskDir('task-1')).toBeNull();
    expect(taskRunsDir('task-1')).toBeNull();
    expect(runDir('task-1', 'run-1')).toBeNull();
    expect(ensureTaskWorkspace(task)).toBeNull();
    expect(ensureRunWorkspace(task, run)).toBeNull();
    expect(finalizeRunWorkspace(task, run, { status: 'success' })).toBeNull();
    expect(workspaceEnv(task, { runId: 'run-1' })).toBeNull();
    expect(workspacePromptBlock(task, { runId: 'run-1' })).toBeNull();

    // Nothing below the root was created either.
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });
});

describe('ensureTaskWorkspace', () => {
  it('creates the task root and the three framework files only', () => {
    const result = ensureTaskWorkspace(makeTask());

    expect(result).toEqual({
      root: path.resolve(dataDir),
      taskDir: taskDir('task-1'),
      runDir: null,
    });
    expect(fs.statSync(taskDir('task-1')).isDirectory()).toBe(true);
    // §10.4: no state/ or tmp/ is prescribed or created.
    expect(fs.existsSync(path.join(taskDir('task-1'), 'state'))).toBe(false);
    expect(fs.existsSync(path.join(taskDir('task-1'), 'tmp'))).toBe(false);
    expect(fs.existsSync(path.join(taskDir('task-1'), 'runs'))).toBe(false);
    expect(fs.existsSync(path.join(taskDir('task-1'), 'task.json'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir('task-1'), 'prompt.md'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir('task-1'), 'README.md'))).toBe(true);
  });

  it('writes a machine snapshot with the documented fields', () => {
    ensureTaskWorkspace(makeTask());

    const snapshot = readJson(path.join(taskDir('task-1'), 'task.json'));
    expect(snapshot).toEqual({
      schemaVersion: SCHEDULED_TASK_SCHEMA_VERSION,
      id: 'task-1',
      title: 'Nightly docs',
      projectPath: '/tmp/scheduled-project',
      provider: 'claude',
      model: 'sonnet',
      kind: 'interval',
      rule: { kind: 'interval', everySeconds: 60, anchorMs: 1 },
      command: 'echo hi',
      commandTimeoutSeconds: 30,
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('accepts camelCase views and keeps an optional url', () => {
    ensureTaskWorkspace({
      id: 'task-2',
      title: 'View shape',
      prompt: 'p',
      projectPath: '/tmp/other',
      provider: 'claude',
      commandTimeoutSeconds: 5,
      rule: { kind: 'once', at: '2030-01-01T00:00:00.000Z' },
      url: 'https://example.test/issue/4',
      updatedAt: '2026-02-02T00:00:00.000Z',
    });

    const snapshot = readJson(path.join(taskDir('task-2'), 'task.json'));
    expect(snapshot.projectPath).toBe('/tmp/other');
    expect(snapshot.rule).toEqual({ kind: 'once', at: '2030-01-01T00:00:00.000Z' });
    expect(snapshot.commandTimeoutSeconds).toBe(5);
    expect(snapshot.url).toBe('https://example.test/issue/4');
    expect(snapshot.updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('falls back for a missing provider/rule and tolerates broken rule_json', () => {
    ensureTaskWorkspace(makeTask({ provider: null, rule_json: 'not json', command: null }));

    const snapshot = readJson(path.join(taskDir('task-1'), 'task.json'));
    expect(snapshot.provider).toBe('claude');
    expect(snapshot.rule).toBeNull();
    expect(snapshot.command).toBeNull();
  });

  it('copies the prompt and writes the README layout contract', () => {
    ensureTaskWorkspace(makeTask());

    expect(fs.readFileSync(path.join(taskDir('task-1'), 'prompt.md'), 'utf8')).toBe('do stuff');
    const readme = fs.readFileSync(path.join(taskDir('task-1'), 'README.md'), 'utf8');
    expect(readme).toContain(taskDir('task-1'));
    expect(readme).toContain('/tmp/scheduled-project');
    expect(readme).toContain('belongs to the task');
    expect(readme).toContain('task.json, prompt.md and README.md');
    expect(readme).toContain('Prefer keeping files the task generates');
    expect(readme).not.toContain('state/');
    expect(readme).not.toMatch(/wiped at the start of every run|Task scratch/);
  });

  it('is idempotent, never wipes task files, and returns null without a usable task id', () => {
    ensureTaskWorkspace(makeTask());
    fs.writeFileSync(path.join(taskDir('task-1'), 'task-owned.txt'), 'x');

    expect(ensureTaskWorkspace(makeTask())).not.toBeNull();
    // Re-running must not wipe the task's own files (nothing does, §10.4).
    expect(fs.existsSync(path.join(taskDir('task-1'), 'task-owned.txt'))).toBe(true);

    expect(ensureTaskWorkspace({ title: 'no id' })).toBeNull();
    expect(ensureTaskWorkspace(null)).toBeNull();
  });
});

describe('ensureRunWorkspace', () => {
  it('creates run.json, prompt.md and logs/ (no tmp/)', () => {
    const task = makeTask();
    const run = makeRun();
    const result = ensureRunWorkspace(task, run);
    const dir = runDir('task-1', 'run-1');

    expect(result).toEqual({
      root: path.resolve(dataDir),
      taskDir: taskDir('task-1'),
      runDir: dir,
    });
    expect(fs.statSync(path.join(dir, 'logs')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tmp'))).toBe(false);
  });

  it('writes every documented run.json field plus the workspace paths', () => {
    ensureRunWorkspace(makeTask(), makeRun());

    const record = readJson(path.join(runDir('task-1', 'run-1'), 'run.json'));
    expect(record).toEqual({
      schemaVersion: SCHEDULED_TASK_SCHEMA_VERSION,
      runId: 'run-1',
      taskId: 'task-1',
      title: 'Nightly docs',
      projectPath: '/tmp/scheduled-project',
      trigger: 'schedule',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: null,
      status: 'running',
      sessionId: null,
      scriptExitCode: null,
      error: null,
      workspace: {
        root: path.resolve(dataDir),
        taskDir: taskDir('task-1'),
        runDir: runDir('task-1', 'run-1'),
      },
    });
  });

  it('writes prompt.md as workspace block + effective prompt', () => {
    const task = makeTask();
    ensureRunWorkspace(task, makeRun(), { effectivePrompt: 'gated prompt' });

    const block = workspacePromptBlock(task, { runId: 'run-1' });
    expect(fs.readFileSync(path.join(runDir('task-1', 'run-1'), 'prompt.md'), 'utf8')).toBe(
      block + '\n\n' + 'gated prompt'
    );
  });

  it('defaults prompt.md to the task prompt and refreshes it on a second call', () => {
    const task = makeTask();
    const run = makeRun();
    ensureRunWorkspace(task, run);
    expect(fs.readFileSync(path.join(runDir('task-1', 'run-1'), 'prompt.md'), 'utf8')).toBe(
      workspacePromptBlock(task, { runId: 'run-1' }) + '\n\n' + 'do stuff'
    );

    ensureRunWorkspace(task, run, { effectivePrompt: 'gate prompt' });
    expect(fs.readFileSync(path.join(runDir('task-1', 'run-1'), 'prompt.md'), 'utf8')).toContain(
      'gate prompt'
    );
    // The earlier run metadata survives the refresh.
    const record = readJson(path.join(runDir('task-1', 'run-1'), 'run.json'));
    expect(record.trigger).toBe('schedule');
    expect(record.startedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(record.status).toBe('running');
  });

  it('returns null without a usable run id', () => {
    expect(ensureRunWorkspace(makeTask(), { id: '' })).toBeNull();
    expect(ensureRunWorkspace(makeTask(), null)).toBeNull();
  });
});


describe('finalizeRunWorkspace', () => {
  it('writes output.md and the final run.json status', () => {
    const task = makeTask();
    const run = makeRun();
    ensureTaskWorkspace(task);
    ensureRunWorkspace(task, run);

    expect(
      finalizeRunWorkspace(task, run, {
        status: 'success',
        output: 'hello\nworld',
        error: null,
        sessionId: 'sess-1',
        scriptExitCode: 0,
      })
    ).toEqual(expect.objectContaining({ runDir: runDir('task-1', 'run-1') }));

    const dir = runDir('task-1', 'run-1');
    expect(fs.readFileSync(path.join(dir, 'output.md'), 'utf8')).toBe('hello\nworld');
    const record = readJson(path.join(dir, 'run.json'));
    expect(record.status).toBe('success');
    expect(record.sessionId).toBe('sess-1');
    expect(record.scriptExitCode).toBe(0);
    expect(record.error).toBeNull();
    expect(record.trigger).toBe('schedule');
    expect(record.startedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(Date.parse(record.finishedAt)).not.toBeNaN();
    // §10.4: the framework never creates (or removes) a per-run tmp/.
    expect(fs.existsSync(path.join(dir, 'tmp'))).toBe(false);
  });

  it('falls back to the error text for output.md', () => {
    const task = makeTask();
    const run = makeRun();
    ensureRunWorkspace(task, run);

    finalizeRunWorkspace(task, run, { status: 'error', error: 'caput' });

    const dir = runDir('task-1', 'run-1');
    expect(fs.readFileSync(path.join(dir, 'output.md'), 'utf8')).toBe('caput');
    expect(readJson(path.join(dir, 'run.json')).error).toBe('caput');
  });

  it('never creates a tmp/ dir anywhere under the task tree', () => {
    const task = makeTask();
    const run = makeRun();
    ensureTaskWorkspace(task);
    ensureRunWorkspace(task, run);

    finalizeRunWorkspace(task, run, { status: 'success', output: 'ok' });

    expect(fs.existsSync(path.join(taskDir('task-1'), 'tmp'))).toBe(false);
    expect(fs.existsSync(path.join(runDir('task-1', 'run-1'), 'tmp'))).toBe(false);
  });

  it('saves the script-gate stdout under logs/', () => {
    const task = makeTask();
    const run = makeRun();
    ensureRunWorkspace(task, run);

    finalizeRunWorkspace(task, run, { status: 'success', output: 'ok', scriptOutput: '{"skip":false}' });

    expect(
      fs.readFileSync(path.join(runDir('task-1', 'run-1'), 'logs', 'gate-stdout.log'), 'utf8')
    ).toBe('{"skip":false}');
  });

  it('keeps the previous status when the caller does not provide one', () => {
    const task = makeTask();
    const run = makeRun();
    ensureRunWorkspace(task, run);

    finalizeRunWorkspace(task, run, { output: 'done' });

    const record = readJson(path.join(runDir('task-1', 'run-1'), 'run.json'));
    expect(record.status).toBe('running');
    expect(fs.readFileSync(path.join(runDir('task-1', 'run-1'), 'output.md'), 'utf8')).toBe('done');
  });

  it('creates the run dir even when ensureRunWorkspace was skipped', () => {
    const task = makeTask();
    finalizeRunWorkspace(task, makeRun(), { status: 'error', error: 'script_failed' });

    expect(fs.existsSync(path.join(runDir('task-1', 'run-1'), 'output.md'))).toBe(true);
  });
});

describe('workspaceEnv', () => {
  it('exposes the three SCHEDULED_TASK_* workspace variables', () => {
    const env = workspaceEnv(makeTask(), { runId: 'run-1' });

    expect(env).toEqual({
      SCHEDULED_TASK_DIR: taskDir('task-1'),
      SCHEDULED_TASK_RUN_ID: 'run-1',
      SCHEDULED_TASK_RUN_DIR: runDir('task-1', 'run-1'),
    });
  });

  it('leaves the run variables empty without a run id', () => {
    const env = workspaceEnv(makeTask());

    expect(env.SCHEDULED_TASK_RUN_ID).toBe('');
    expect(env.SCHEDULED_TASK_RUN_DIR).toBe('');
    expect(env.SCHEDULED_TASK_DIR).toBe(taskDir('task-1'));
  });
});

describe('workspacePromptBlock', () => {
  it('states the project directory, the task root and this run directory', () => {
    const block = workspacePromptBlock(makeTask(), { runId: 'run-1' });

    expect(block).toContain('Nightly docs');
    expect(block).toContain('task id: task-1');
    expect(block).toContain('run id: run-1');
    expect(block).toContain('/tmp/scheduled-project');
    expect(block).toContain(taskDir('task-1'));
    expect(block).toContain(runDir('task-1', 'run-1'));
    expect(block).toContain('output.md');
    expect(block).toContain('logs/');
    expect(block).toContain('belongs to the task');
    expect(block).toContain('task.json, prompt.md and README.md');
    expect(block).toContain('Prefer keeping files the task generates');
    expect(block).not.toContain('state/');
    expect(block).not.toMatch(/wiped at the start of every run|Task scratch|Durable task state/);
    expect(block.startsWith('## Scheduled task workspace')).toBe(true);
  });

  it('renders the generic contract with placeholders when there is no task', () => {
    const block = workspacePromptBlock();

    expect(block).toContain('<task id>');
    expect(block).toContain('<task title>');
    expect(block).toContain('<project directory>');
    expect(block).toContain('<runId>');
    expect(block).toContain('belongs to the task');
    expect(block).toContain('Prefer keeping files the task generates');
    expect(block).not.toContain('state/');
  });

  it('never throws when a task id cannot be used as a path segment', () => {
    expect(() => workspacePromptBlock({ id: '../evil', title: 'x' })).not.toThrow();
    expect(workspacePromptBlock({ id: '../evil' })).toContain('<task root>');
  });
});

describe('parameters (§12)', () => {
  it('records the parameter definitions on task.json', () => {
    ensureTaskWorkspace(makeTask({ params_json: '[{"name":"region","type":"string","default":"eu"}]' }));

    const snapshot = readJson(path.join(taskDir('task-1'), 'task.json'));
    expect(snapshot.params).toEqual([{ name: 'region', type: 'string', default: 'eu' }]);
  });

  it('omits params from task.json when the task declares none', () => {
    ensureTaskWorkspace(makeTask());
    expect(readJson(path.join(taskDir('task-1'), 'task.json'))).not.toHaveProperty('params');
  });

  it('records the resolved values on run.json and the Parameters block in prompt.md', () => {
    const task = makeTask();
    const run = makeRun({ params_json: '{"region":"eu"}' });
    const paramsBlock = '## Scheduled task parameters\n\n- region = eu';

    ensureRunWorkspace(task, run, { effectivePrompt: 'p', paramsBlock });

    const record = readJson(path.join(runDir('task-1', 'run-1'), 'run.json'));
    expect(record.params).toEqual({ region: 'eu' });

    const block = workspacePromptBlock(task, { runId: 'run-1' });
    expect(fs.readFileSync(path.join(runDir('task-1', 'run-1'), 'prompt.md'), 'utf8')).toBe(
      `${block}\n\n${paramsBlock}\n\np`
    );
  });

  it('keeps run.json free of params when the run has none', () => {
    ensureRunWorkspace(makeTask(), makeRun());
    expect(readJson(path.join(runDir('task-1', 'run-1'), 'run.json'))).not.toHaveProperty('params');
  });
});

