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
        conflict_policy: input.conflictPolicy ?? 'skip',
        tags_json: input.tagsJson ?? null,
        project_paths_json: input.projectPathsJson ?? null,
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
        conflictPolicy: 'conflict_policy',
        tagsJson: 'tags_json',
        projectPathsJson: 'project_paths_json',
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
  it('exposes the eight preset methods and forwards arguments', async () => {
    const presets = {
      listPresets: vi.fn(async () => ({ ok: true, presets: [] })),
      getPreset: vi.fn(async () => ({ ok: true, preset: {} })),
      installPreset: vi.fn(async () => ({ ok: true })),
      setPresetEnabled: vi.fn(async () => ({ ok: true })),
      upgradePreset: vi.fn(async () => ({ ok: true })),
      createCustomPreset: vi.fn(async () => ({ ok: true })),
      updatePreset: vi.fn(async () => ({ ok: true })),
      deletePreset: vi.fn(async () => ({ ok: true })),
    };
    const { management } = setup({ deps: { presets } });

    await management.presets.listPresets({ projectPath: PROJECT });
    await management.presets.getPreset('p1', { projectPath: PROJECT });
    await management.presets.installPreset('p1', { projectPath: PROJECT, enabled: false });
    await management.presets.setPresetEnabled('p1', true, { projectPath: PROJECT });
    await management.presets.upgradePreset('p1', { projectPath: PROJECT });
    await management.presets.createCustomPreset({ name: 'x', projectPath: PROJECT, taskIds: ['t'] });
    await management.presets.updatePreset('p1', { name: 'y' }, { projectPath: PROJECT });
    await management.presets.deletePreset('p1', { purge: false }, { projectPath: PROJECT });

    expect(presets.listPresets).toHaveBeenCalledWith({ projectPath: PROJECT });
    expect(presets.getPreset).toHaveBeenCalledWith('p1', { projectPath: PROJECT });
    expect(presets.installPreset).toHaveBeenCalledWith('p1', { projectPath: PROJECT, enabled: false });
    expect(presets.setPresetEnabled).toHaveBeenCalledWith('p1', true, { projectPath: PROJECT });
    expect(presets.upgradePreset).toHaveBeenCalledWith('p1', { projectPath: PROJECT });
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

describe('copyTask (§15)', () => {
  it('copies the definition, starts paused and drops history/preset links', async () => {
    const { repo, management, workspace } = setup();
    const source = await management.createTask({
      ...baseTask,
      command: 'echo hi',
      commandTimeoutSeconds: 30,
      params: [{ name: 'region', default: 'eu' }],
      presetId: 'preset-1',
      presetTaskId: 'tpl-1',
    });
    repo._tasks.get(source.task.id).run_count = 5;

    const result = await management.copyTask(source.task.id);

    expect(result.ok).toBe(true);
    expect(result.task.id).not.toBe(source.task.id);
    expect(result.task).toMatchObject({
      title: 'a (copy)',
      prompt: 'p',
      projectPath: PROJECT,
      enabled: false,
      nextRunAt: null,
      command: 'echo hi',
      commandTimeoutSeconds: 30,
      runCount: 0,
      presetId: null,
      presetTaskId: null,
    });
    expect(result.task.params).toEqual([{ name: 'region', type: 'string', default: 'eu' }]);
    expect(workspace.ensureTaskWorkspace).toHaveBeenCalled();
  });

  it('honours title/projectPath overrides and enabled:true', async () => {
    const { management } = setup();
    const source = await management.createTask(baseTask);

    const result = await management.copyTask(source.task.id, {
      title: 'clone',
      projectPath: '/tmp/other',
      enabled: true,
    });

    expect(result.task).toMatchObject({ title: 'clone', projectPath: '/tmp/other', enabled: true });
    expect(result.task.nextRunAt).toBeTruthy();
  });

  it('is scoped: a task outside the project behaves as not_found', async () => {
    const { management } = setup();
    const source = await management.createTask(baseTask);

    const result = await management.copyTask(source.task.id, {}, { projectPath: '/tmp/elsewhere' });

    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('import/export (§16)', () => {
  it('exports a portable envelope without ids or history', async () => {
    const { management } = setup();
    const source = await management.createTask({ ...baseTask, params: [{ name: 'a' }] });

    const result = await management.exportTask(source.task.id);

    expect(result.ok).toBe(true);
    expect(result.format).toBe('claudecodeui.scheduled-task');
    expect(result.version).toBe(1);
    expect(result.task).toMatchObject({ title: 'a', prompt: 'p', projectPath: PROJECT });
    expect(result.task.id).toBeUndefined();
    expect(result.task.nextRunAt).toBeUndefined();
    expect(result.task.params).toEqual([{ name: 'a', type: 'string' }]);
  });

  it('imports an envelope paused and validates format/version', async () => {
    const { management } = setup();
    const envelope = { format: 'claudecodeui.scheduled-task', version: 1, task: { ...baseTask } };

    const result = await management.importTask(envelope);
    expect(result.ok).toBe(true);
    expect(result.task).toMatchObject({ title: 'a', enabled: false, nextRunAt: null });

    expect(await management.importTask({ format: 'nope', task: baseTask })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(
      await management.importTask({ format: 'claudecodeui.scheduled-task', version: 99, task: baseTask })
    ).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('resolves the target project from input > envelope > scope', async () => {
    const { management } = setup();
    const envelope = { task: { title: 'i', prompt: 'p', rule: baseTask.rule } };

    const scoped = await management.importTask(envelope, { projectPath: '/tmp/scoped' });
    expect(scoped.task.projectPath).toBe('/tmp/scoped');

    const explicit = await management.importTask({ ...envelope, projectPath: '/tmp/explicit' });
    expect(explicit.task.projectPath).toBe('/tmp/explicit');
  });
});
describe('conflict policy (§17)', () => {
  it('validates, stores and returns the policy', async () => {
    const { repo, management } = setup();
    const created = await management.createTask({ ...baseTask, conflictPolicy: 'queue' });
    expect(created.task.conflictPolicy).toBe('queue');
    expect(repo._tasks.get(created.task.id).conflict_policy).toBe('queue');

    expect(await management.createTask({ ...baseTask, conflictPolicy: 'nope' })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });

    const updated = await management.updateTask(created.task.id, { conflictPolicy: 'replace' });
    expect(updated.task.conflictPolicy).toBe('replace');

    const plain = await management.createTask(baseTask);
    expect(plain.task.conflictPolicy).toBe('skip');
  });

  it('carries the policy over to a copy and reads legacy rows as skip', async () => {
    const { management } = setup();
    const created = await management.createTask({ ...baseTask, conflictPolicy: 'replace' });

    const copy = await management.copyTask(created.task.id);

    expect(copy.task.conflictPolicy).toBe('replace');
    expect(taskRowToJson({}).conflictPolicy).toBe('skip');
  });

  it('reports a queued manual run without a run row', async () => {
    const runNow = vi.fn(async () => ({ queued: true }));
    const { management } = setup({ deps: { runNow } });
    const created = await management.createTask(baseTask);

    const result = await management.runTaskNow(created.task.id);

    expect(result).toEqual({ ok: true, queued: true, run: null, runs: [] });
    expect(runNow).toHaveBeenCalledWith(created.task.id);
  });
});
describe('tags (§19)', () => {
  it('normalizes, stores, updates and filters tags', async () => {
    const { management } = setup();
    const created = await management.createTask({ ...baseTask, tags: ['Ops', 'docs', 'ops'] });
    expect(created.task.tags).toEqual(['Ops', 'docs']);

    expect(await management.createTask({ ...baseTask, tags: [''] })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });

    const updated = await management.updateTask(created.task.id, { tags: [] });
    expect(updated.task.tags).toEqual([]);

    const tagged = await management.createTask({ ...baseTask, tags: ['ops'] });
    const filtered = await management.listTasks({ tag: 'OPS' }, {});
    expect(filtered.tasks.map((task) => task.id)).toEqual([tagged.task.id]);
  });

  it('carries tags through copy and export/import', async () => {
    const { management } = setup();
    const created = await management.createTask({ ...baseTask, tags: ['ops'] });

    expect((await management.copyTask(created.task.id)).task.tags).toEqual(['ops']);
    const exported = await management.exportTask(created.task.id);
    expect(exported.task.tags).toEqual(['ops']);
    expect((await management.importTask(exported)).task.tags).toEqual(['ops']);
  });
});

describe('preview and upcoming (§20, §21)', () => {
  it('forwards preview to the runner and rejects unknown tasks', async () => {
    const previewTask = vi.fn(async () => ({ decision: 'skip', reason: 'nothing to do' }));
    const { management } = setup({ deps: { previewTask } });
    const created = await management.createTask(baseTask);

    const result = await management.previewTask(created.task.id);

    expect(result).toEqual({ ok: true, preview: { decision: 'skip', reason: 'nothing to do' } });
    expect(previewTask).toHaveBeenCalledWith(expect.objectContaining({ id: created.task.id }), {
      params: undefined,
    });
    expect(await management.previewTask('nope')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('lists upcoming occurrences inside the horizon', async () => {
    const { management } = setup();
    await management.createTask({ ...baseTask, rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' } });

    const result = await management.listUpcoming({ days: 2 }, {});

    expect(result.ok).toBe(true);
    expect(result.upcoming.length).toBeGreaterThan(0);
    expect(result.upcoming[0]).toMatchObject({ title: 'a', projectPath: PROJECT });
    expect(result.upcoming[0].at).toBe('2030-06-04T09:00:00.000Z');
  });
});




describe('multi-project binding (§22)', () => {
  it('stores the full binding and keeps the first as projectPath', async () => {
    const { repo, management } = setup();
    const result = await management.createTask({
      ...baseTask,
      projectPaths: ['/tmp/a', '/tmp/b', ' /tmp/a '],
    });

    expect(result.ok).toBe(true);
    expect(result.task.projectPaths).toEqual(['/tmp/a', '/tmp/b']);
    expect(result.task.projectPath).toBe('/tmp/a');
    expect(repo._tasks.get(result.task.id).project_paths_json).toBe(
      JSON.stringify(['/tmp/a', '/tmp/b'])
    );
  });

  it('reads legacy rows as a one-element binding and rejects an empty list', async () => {
    const { management } = setup();
    const created = await management.createTask(baseTask);
    expect(created.task.projectPaths).toEqual([PROJECT]);

    const bad = await management.createTask({ ...baseTask, projectPaths: [] });
    expect(bad).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('is in scope from any bound project', async () => {
    const { management } = setup();
    const created = await management.createTask({ ...baseTask, projectPaths: ['/tmp/a', '/tmp/b'] });

    await expect(management.getTask(created.task.id, { projectPath: '/tmp/b' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(management.getTask(created.task.id, { projectPath: '/tmp/c' })).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('replaces the whole binding on update and collapses a single projectPath', async () => {
    const { management } = setup();
    const created = await management.createTask({ ...baseTask, projectPaths: ['/tmp/a', '/tmp/b'] });

    const updated = await management.updateTask(created.task.id, {
      projectPaths: ['/tmp/c', '/tmp/d'],
    });
    expect(updated.task.projectPaths).toEqual(['/tmp/c', '/tmp/d']);
    expect(updated.task.projectPath).toBe('/tmp/c');

    const collapsed = await management.updateTask(created.task.id, { projectPath: '/tmp/e' });
    expect(collapsed.task.projectPaths).toEqual(['/tmp/e']);
    expect(collapsed.task.projectPath).toBe('/tmp/e');
  });

  it('carries the binding through copy, export and import', async () => {
    const { management } = setup();
    const created = await management.createTask({ ...baseTask, projectPaths: ['/tmp/a', '/tmp/b'] });

    const copied = await management.copyTask(created.task.id, {});
    expect(copied.task.projectPaths).toEqual(['/tmp/a', '/tmp/b']);

    const exported = await management.exportTask(created.task.id);
    expect(exported.task.projectPaths).toEqual(['/tmp/a', '/tmp/b']);

    const imported = await management.importTask(exported.task);
    expect(imported.task.projectPaths).toEqual(['/tmp/a', '/tmp/b']);
  });
});

describe('running runs list (§22)', () => {
  it('maps the repository rows into running run views', async () => {
    const { repo, management } = setup();
    repo.countRunningAgentRuns = vi.fn(() => 1);
    repo.listRunningAgentRuns = vi.fn(() => [
      {
        id: 'run-1',
        task_id: 't1',
        status: 'running',
        trigger: 'schedule',
        scheduled_for: iso(NOW),
        started_at: iso(NOW),
        agent_started_at: iso(NOW),
        session_id: 'sess-1',
        project_path: '/tmp/a',
        task_title: 'Task A',
        task_project_path: '/tmp/a',
        task_project_paths_json: JSON.stringify(['/tmp/a', '/tmp/b']),
      },
    ]);

    const result = await management.listRunningTasks(10);

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(result.runs[0]).toMatchObject({
      id: 'run-1',
      taskId: 't1',
      taskTitle: 'Task A',
      projectPath: '/tmp/a',
      sessionId: 'sess-1',
    });
    expect(repo.listRunningAgentRuns).toHaveBeenCalledWith(10);
  });

  it('reads as an empty list when the repository cannot list', async () => {
    const { management } = setup();
    await expect(management.listRunningTasks()).resolves.toEqual({ ok: true, count: 0, runs: [] });
  });
});
