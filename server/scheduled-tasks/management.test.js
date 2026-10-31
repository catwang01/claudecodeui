import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createManagement, runRowToJson, taskRowToJson } from './management.js';
import * as rules from './rules.js';

const NOW = Date.parse('2030-06-03T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const PROJECT = '/tmp/mgmt-project';

function makeRepo() {
  const tasks = new Map();
  let seq = 0;
  const stamp = () => iso(NOW);

  return {
    createTask(input) {
      const id = input.id || `task-${++seq}`;
      const row = {
        id,
        user_id: input.userId ?? null,
        title: input.title,
        prompt: input.prompt,
        project_path: input.projectPath,
        provider: input.provider ?? 'claude',
        model: input.model ?? null,
        command: input.command ?? null,
        command_timeout_seconds: input.commandTimeoutSeconds ?? null,
        params_json: input.paramsJson ?? null,
        kind: input.kind,
        rule_json: input.ruleJson,
        next_run_at: input.nextRunAt ?? null,
        last_run_at: null,
        last_status: null,
        last_error: null,
        enabled: input.enabled === false ? 0 : 1,
        run_count: 0,
        preset_id: input.presetId ?? null,
        preset_task_id: input.presetTaskId ?? null,
        created_at: stamp(),
        updated_at: stamp(),
      };
      tasks.set(id, row);
      return row;
    },
    getTask: vi.fn((id) => tasks.get(id)),
    listTasks: vi.fn(() => [...tasks.values()]),
    updateTask: vi.fn((id, patch) => {
      const row = tasks.get(id);
      if (!row) return undefined;
      const columns = {
        title: 'title',
        prompt: 'prompt',
        projectPath: 'project_path',
        provider: 'provider',
        model: 'model',
        command: 'command',
        commandTimeoutSeconds: 'command_timeout_seconds',
        kind: 'kind',
        ruleJson: 'rule_json',
        nextRunAt: 'next_run_at',
        enabled: 'enabled',
        paramsJson: 'params_json',
        presetId: 'preset_id',
        presetTaskId: 'preset_task_id',
      };
      for (const [key, value] of Object.entries(patch)) {
        row[columns[key] || key] = key === 'enabled' ? (value ? 1 : 0) : value;
      }
      row.updated_at = stamp();
      return row;
    }),
    deleteTask: vi.fn((id) => tasks.delete(id)),
    listRuns: vi.fn(() => []),
    countRuns: vi.fn(() => 0),
    _tasks: tasks,
  };
}

function setup(overrides = {}) {
  const repo = makeRepo();
  const workspace = { ensureTaskWorkspace: vi.fn(() => null), ...(overrides.workspace || {}) };
  const management = createManagement({
    repo,
    rules,
    now: () => NOW,
    workspace,
    ...overrides.deps,
  });
  return { repo, workspace, management };
}

const baseTask = {
  title: 'a',
  prompt: 'p',
  projectPath: PROJECT,
  rule: { kind: 'interval', everySeconds: 3600 },
};

describe('taskRowToJson preset fields (§10.2)', () => {
  it('maps snake_case and camelCase preset links', () => {
    expect(taskRowToJson({ preset_id: 'p1', preset_task_id: 't1' })).toMatchObject({
      presetId: 'p1',
      presetTaskId: 't1',
    });
    expect(taskRowToJson({ presetId: 'p2', presetTaskId: 't2' })).toMatchObject({
      presetId: 'p2',
      presetTaskId: 't2',
    });
    expect(taskRowToJson({})).toMatchObject({ presetId: null, presetTaskId: null });
  });
});

describe('createTask / updateTask (§10.4 workspace hooks)', () => {
  it('passes presetId/presetTaskId to the repository', async () => {
    const { repo, management } = setup();
    const result = await management.createTask({ ...baseTask, presetId: 'preset-1', presetTaskId: 'tpl-1' });

    expect(result.ok).toBe(true);
    expect(repo._tasks.get(result.task.id)).toMatchObject({
      preset_id: 'preset-1',
      preset_task_id: 'tpl-1',
    });
    expect(result.task).toMatchObject({ presetId: 'preset-1', presetTaskId: 'tpl-1' });
  });

  it('ensures the task workspace after create and update', async () => {
    const { workspace, management } = setup();
    const created = await management.createTask(baseTask);
    expect(workspace.ensureTaskWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.task.id, project_path: PROJECT })
    );

    await management.updateTask(created.task.id, { title: 'renamed' });
    expect(workspace.ensureTaskWorkspace).toHaveBeenCalledTimes(2);
  });

  it('never fails the request when the workspace setup throws', async () => {
    const ensureTaskWorkspace = vi.fn(() => {
      throw new Error('disk full');
    });
    const { management } = setup({ workspace: { ensureTaskWorkspace } });

    const result = await management.createTask(baseTask);

    expect(result.ok).toBe(true);
    expect(ensureTaskWorkspace).toHaveBeenCalledTimes(1);
  });

  it('works when the workspace is disabled', async () => {
    const repo = makeRepo();
    const management = createManagement({ repo, rules, now: () => NOW, workspace: false });
    const result = await management.createTask(baseTask);
    expect(result.ok).toBe(true);
  });
});

describe('deleteTask purge (§10.4)', () => {
  it('does not touch the workspace by default', async () => {
    const { repo, workspace, management } = setup();
    const created = await management.createTask(baseTask);

    const result = await management.deleteTask(created.task.id);

    expect(result).toMatchObject({ ok: true, id: created.task.id, deleted: true, purged: false });
    expect(workspace.removeTaskWorkspace).toBeUndefined();
    expect(repo.deleteTask).toHaveBeenCalledWith(created.task.id);
  });

  it('purges through removeTaskWorkspace when purge is requested', async () => {
    const removeTaskWorkspace = vi.fn(() => true);
    const { management } = setup({ workspace: { removeTaskWorkspace } });
    const created = await management.createTask(baseTask);

    const result = await management.deleteTask(created.task.id, {}, { purge: true });

    expect(result.purged).toBe(true);
    expect(removeTaskWorkspace).toHaveBeenCalledWith(created.task.id);
  });

  it('falls back to removing taskDir when the workspace has no remover', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-task-purge-'));
    fs.mkdirSync(path.join(dir, 'state'));
    const { management } = setup({ workspace: { taskDir: () => dir } });
    const created = await management.createTask(baseTask);

    const result = await management.deleteTask(created.task.id, {}, { purge: true });

    expect(result.purged).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('preset service delegation (§10.3)', () => {
  it('exposes the seven preset methods and forwards arguments', async () => {
    const presets = {
      listPresets: vi.fn(async () => ({ ok: true, presets: [] })),
      getPreset: vi.fn(async () => ({ ok: true, preset: {} })),
      installPreset: vi.fn(async () => ({ ok: true })),
      setPresetEnabled: vi.fn(async () => ({ ok: true })),
      createCustomPreset: vi.fn(async () => ({ ok: true })),
      updatePreset: vi.fn(async () => ({ ok: true })),
      deletePreset: vi.fn(async () => ({ ok: true })),
    };
    const { management } = setup({ deps: { presets } });

    await management.presets.listPresets({ projectPath: PROJECT });
    await management.presets.getPreset('p1', { projectPath: PROJECT });
    await management.presets.installPreset('p1', { projectPath: PROJECT, enabled: false });
    await management.presets.setPresetEnabled('p1', true, { projectPath: PROJECT });
    await management.presets.createCustomPreset({ name: 'x', projectPath: PROJECT, taskIds: ['t'] });
    await management.presets.updatePreset('p1', { name: 'y' }, { projectPath: PROJECT });
    await management.presets.deletePreset('p1', { purge: false }, { projectPath: PROJECT });

    expect(presets.listPresets).toHaveBeenCalledWith({ projectPath: PROJECT });
    expect(presets.getPreset).toHaveBeenCalledWith('p1', { projectPath: PROJECT });
    expect(presets.installPreset).toHaveBeenCalledWith('p1', { projectPath: PROJECT, enabled: false });
    expect(presets.setPresetEnabled).toHaveBeenCalledWith('p1', true, { projectPath: PROJECT });
    expect(presets.createCustomPreset).toHaveBeenCalledWith({ name: 'x', projectPath: PROJECT, taskIds: ['t'] });
    expect(presets.updatePreset).toHaveBeenCalledWith('p1', { name: 'y' }, { projectPath: PROJECT });
    expect(presets.deletePreset).toHaveBeenCalledWith('p1', { purge: false }, { projectPath: PROJECT });
  });
});

describe('parameters (§12)', () => {
  it('normalizes and stores params on create', async () => {
    const { repo, management } = setup();
    const result = await management.createTask({
      ...baseTask,
      params: [
        { name: 'region', default: 'eu', description: ' target region ' },
        { name: 'threshold', type: 'number', default: '3' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.task.params).toEqual([
      { name: 'region', type: 'string', default: 'eu', description: 'target region' },
      { name: 'threshold', type: 'number', default: 3 },
    ]);
    expect(repo._tasks.get(result.task.id).params_json).toBe(JSON.stringify(result.task.params));
  });

  it('rejects an invalid definition with invalid_input before the repository', async () => {
    const { repo, management } = setup();
    const result = await management.createTask({ ...baseTask, params: [{ name: '1bad' }] });

    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(repo._tasks.size).toBe(0);
  });

  it('updates and clears params', async () => {
    const { management } = setup();
    const created = await management.createTask({ ...baseTask, params: [{ name: 'a' }] });

    const updated = await management.updateTask(created.task.id, {
      params: [{ name: 'b', type: 'boolean' }],
    });
    expect(updated.task.params).toEqual([{ name: 'b', type: 'boolean' }]);

    const cleared = await management.updateTask(created.task.id, { params: null });
    expect(cleared.task.params).toEqual([]);
  });

  it('maps params on the task and run views (legacy JSON reads as [])', () => {
    expect(taskRowToJson({ params_json: '[{"name":"a"}]' }).params).toEqual([
      { name: 'a', type: 'string' },
    ]);
    expect(taskRowToJson({ params_json: 'not json' }).params).toEqual([]);
    expect(taskRowToJson({}).params).toEqual([]);
    expect(runRowToJson({ params_json: '{"a":1}' }).params).toEqual({ a: 1 });
    expect(runRowToJson({}).params).toBeNull();
  });

  it('forwards per-run overrides and rejects unknown names at request time', async () => {
    const runNow = vi.fn(async (taskId) => ({
      run: { id: 'run-1', task_id: taskId, status: 'running', trigger: 'manual' },
    }));
    const { management } = setup({ deps: { runNow } });
    const created = await management.createTask({ ...baseTask, params: [{ name: 'region', default: 'eu' }] });

    const ok = await management.runTaskNow(created.task.id, {}, { params: { region: 'us' } });
    expect(ok.ok).toBe(true);
    expect(runNow).toHaveBeenCalledWith(created.task.id, { params: { region: 'us' } });

    const bad = await management.runTaskNow(created.task.id, {}, { params: { nope: 1 } });
    expect(bad).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(runNow).toHaveBeenCalledTimes(1);
  });

  it('still starts the run when a required parameter has no value (recorded on the run)', async () => {
    const runNow = vi.fn(async (taskId) => ({
      run: { id: 'run-1', task_id: taskId, status: 'running', trigger: 'manual' },
    }));
    const { management } = setup({ deps: { runNow } });
    const created = await management.createTask({ ...baseTask, params: [{ name: 'token', required: true }] });

    const result = await management.runTaskNow(created.task.id, {}, { params: {} });
    expect(result.ok).toBe(true);
    expect(runNow).toHaveBeenCalledWith(created.task.id, { params: {} });
  });
});

describe('running count (§14.3)', () => {
  it('reads the repository count', async () => {
    const { repo, management } = setup();
    repo.countRunningAgentRuns = vi.fn(() => 3);

    await expect(management.countRunningTasks()).resolves.toEqual({ ok: true, count: 3 });
    expect(repo.countRunningAgentRuns).toHaveBeenCalledTimes(1);
  });

  it('reads as 0 when the repository cannot count (older fakes)', async () => {
    const { management } = setup();

    await expect(management.countRunningTasks()).resolves.toEqual({ ok: true, count: 0 });
  });

  it('exposes agentStartedAt on the run view and defaults it to null', () => {
    expect(runRowToJson({ id: 'run-1', agent_started_at: '2026-01-01T00:00:00.000Z' }).agentStartedAt).toBe(
      '2026-01-01T00:00:00.000Z'
    );
    expect(runRowToJson({ id: 'run-1', status: 'running' }).agentStartedAt).toBeNull();
  });
});

