import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BUILTIN_PRESET_DIR,
  loadBuiltinCatalog,
  validateBuiltinPreset,
  createPresetService,
} from './presets.js';
import * as rules from './rules.js';

const NOW = Date.parse('2030-06-03T12:00:00.000Z'); // a Monday
const iso = (ms) => new Date(ms).toISOString();
const PROJECT = '/tmp/preset-project';
const OTHER = '/tmp/preset-other';

function projectPathOf(row) {
  return row.project_path ?? row.projectPath ?? null;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

function makeTaskRow(input, id) {
  const stamp = iso(NOW);
  return {
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
    created_at: stamp,
    updated_at: stamp,
  };
}

function makeRepo() {
  const presets = new Map();
  const presetTasks = new Map();
  const tasks = new Map();
  let seq = 0;
  const stamp = () => iso(NOW);

  return {
    createPreset(input) {
      const id = input.id || `preset-${++seq}`;
      const row = {
        id,
        user_id: input.userId ?? null,
        source: input.source,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        version: input.version ?? null,
        enabled: input.enabled ? 1 : 0,
        project_path: input.projectPath ?? null,
        created_at: stamp(),
        updated_at: stamp(),
      };
      presets.set(id, row);
      return row;
    },
    getPreset: vi.fn((id) => presets.get(id)),
    listPresets: vi.fn((opts) => {
      const rows = [...presets.values()];
      if (!opts || opts.projectPath === undefined) return rows;
      if (opts.projectPath === null || opts.projectPath === '') {
        return rows.filter((preset) => preset.source === 'builtin');
      }
      return rows.filter(
        (preset) => preset.source === 'builtin' || samePath(projectPathOf(preset), opts.projectPath)
      );
    }),
    updatePreset: vi.fn((id, patch) => {
      const row = presets.get(id);
      if (!row) return undefined;
      if ('name' in patch) row.name = patch.name;
      if ('description' in patch) row.description = patch.description;
      if ('icon' in patch) row.icon = patch.icon;
      if ('version' in patch) row.version = patch.version;
      if ('enabled' in patch) row.enabled = patch.enabled ? 1 : 0;
      if ('projectPath' in patch) row.project_path = patch.projectPath;
      if ('userId' in patch) row.user_id = patch.userId;
      row.updated_at = stamp();
      return row;
    }),
    deletePreset: vi.fn((id) => {
      presetTasks.delete(id);
      return presets.delete(id);
    }),
    replacePresetTasks: vi.fn((presetId, list) => {
      if (!presets.has(presetId)) return [];
      const rows = list.map((task, index) => ({
        id: task.id || `pt-${++seq}`,
        preset_id: presetId,
        title: task.title,
        description: task.description ?? null,
        prompt: task.prompt,
        provider: task.provider ?? 'claude',
        model: task.model ?? null,
        kind: task.kind,
        rule_json: task.ruleJson ?? JSON.stringify(task.rule),
        command: task.command ?? null,
        command_timeout_seconds: task.commandTimeoutSeconds ?? null,
        params_json: task.paramsJson ?? task.params_json ?? null,
        position: task.position ?? index,
        created_at: stamp(),
        updated_at: stamp(),
      }));
      presetTasks.set(presetId, rows);
      return rows;
    }),
    listPresetTasks: vi.fn((presetId) =>
      [...(presetTasks.get(presetId) || [])].sort((a, b) => a.position - b.position)
    ),
    listTasksByPreset: vi.fn((presetId) => [...tasks.values()].filter((task) => task.preset_id === presetId)),
    createTask(input) {
      const id = input.id || `task-${++seq}`;
      const row = makeTaskRow(input, id);
      tasks.set(id, row);
      return row;
    },
    getTask: vi.fn((id) => tasks.get(id)),
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
      };
      for (const [key, value] of Object.entries(patch)) {
        row[columns[key] || key] = key === 'enabled' ? (value ? 1 : 0) : value;
      }
      row.updated_at = stamp();
      return row;
    }),
    deleteTask: vi.fn((id) => tasks.delete(id)),
    _presets: presets,
    _presetTasks: presetTasks,
    _tasks: tasks,
  };
}

const CATALOG = [
  {
    id: 'alpha-daily',
    name: 'Alpha daily',
    description: 'Daily alpha work',
    icon: 'Clock',
    version: '1.0.0',
    tasks: [
      {
        id: 'alpha-task',
        title: 'Alpha task',
        prompt: 'do alpha',
        rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      },
    ],
  },
  {
    id: 'beta-weekly',
    name: 'Beta weekly',
    version: '1.0.0',
    tasks: [
      {
        id: 'beta-scan',
        title: 'Beta scan',
        prompt: 'do beta',
        command: 'echo {}',
        commandTimeoutSeconds: 30,
        rule: { kind: 'weekly', time: '08:00', timeZone: 'UTC', weekdays: [1, 5] },
      },
    ],
  },
  {
    id: 'gamma-interval',
    name: 'Gamma interval',
    version: '1.0.0',
    tasks: [
      {
        id: 'gamma-tick',
        title: 'Gamma tick',
        prompt: 'do gamma',
        rule: { kind: 'interval', everySeconds: 3600 },
      },
    ],
  },
  {
    id: 'delta-exhausted',
    name: 'Delta exhausted',
    version: '1.0.0',
    tasks: [
      {
        id: 'delta-never',
        title: 'Delta never',
        prompt: 'never runs',
        rule: { kind: 'once', at: '2020-01-01T00:00:00.000Z' },
      },
    ],
  },
];

function setup(catalog = CATALOG) {
  const repo = makeRepo();
  const workspace = { ensureTaskWorkspace: vi.fn(() => null) };
  const service = createPresetService({
    repo,
    rules,
    catalog,
    workspace,
    now: () => NOW,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  return { repo, service, workspace };
}

function presetById(result, id) {
  return result.presets.find((preset) => preset.id === id);
}

describe('loadBuiltinCatalog (shipped catalog)', () => {
  it('loads the version-controlled catalog sorted by id', () => {
    const catalog = loadBuiltinCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(3);
    expect(catalog.map((preset) => preset.id)).toEqual([...catalog.map((preset) => preset.id)].sort());
    expect(BUILTIN_PRESET_DIR.endsWith(path.join('presets', 'builtin'))).toBe(true);
  });

  it('keeps every shipped template repeatable (no absolute once) and unique', () => {
    const catalog = loadBuiltinCatalog();
    const ids = new Set();
    let gated = 0;
    for (const preset of catalog) {
      expect(preset.tasks.length).toBeGreaterThan(0);
      for (const task of preset.tasks) {
        expect(ids.has(task.id), `duplicate template id ${task.id}`).toBe(false);
        ids.add(task.id);
        expect(['daily', 'weekly', 'cron', 'interval']).toContain(task.rule.kind);
        expect(task.prompt).toMatch(/SCHEDULED_TASK_DIR/);
        expect(task.prompt).toMatch(/runs\/|SCHEDULED_TASK_RUN_DIR/);
        // §10.4: the framework no longer hands out state/ or tmp/ dirs.
        expect(task.prompt).not.toMatch(/SCHEDULED_TASK_STATE_DIR|SCHEDULED_TASK_TMP_DIR/);
        if (task.command) gated += 1;
      }
    }
    expect(gated).toBeGreaterThanOrEqual(1);
  });
});

describe('validateBuiltinPreset', () => {
  const base = {
    id: 'ok-preset',
    name: 'Ok',
    tasks: [{ id: 'ok-task', title: 'T', prompt: 'p', rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' } }],
  };

  it('accepts a well-formed catalog file', () => {
    const result = validateBuiltinPreset(base);
    expect(result.ok).toBe(true);
    expect(result.preset.tasks[0]).toMatchObject({ id: 'ok-task', provider: 'claude', command: null });
  });

  it('rejects malformed shapes with invalid_catalog', () => {
    const bad = [
      null,
      [],
      { ...base, id: 'Not Kebab' },
      { ...base, name: '' },
      { ...base, tasks: 'nope' },
      { ...base, tasks: [] },
      { ...base, tasks: [{ ...base.tasks[0], id: 'dup' }, { ...base.tasks[0], id: 'dup' }] },
      { ...base, tasks: [{ ...base.tasks[0], prompt: '' }] },
      { ...base, tasks: [{ ...base.tasks[0], rule: { kind: 'nope' } }] },
      { ...base, tasks: [{ ...base.tasks[0], commandTimeoutSeconds: 0 }] },
    ];
    for (const value of bad) {
      const result = validateBuiltinPreset(value);
      expect(result.ok, JSON.stringify(value)).toBe(false);
      expect(result.code).toBe('invalid_catalog');
    }
  });
});

describe('builtin catalog seeding', () => {
  it('seeds rows and templates, and does not rewrite them on a second read', () => {
    const { repo, service } = setup();
    return service.listPresets().then((first) => {
      expect(first.ok).toBe(true);
      expect(first.presets).toHaveLength(CATALOG.length);
      const alpha = presetById(first, 'alpha-daily');
      expect(alpha).toMatchObject({ source: 'builtin', enabled: false, projectPath: null, taskCount: 1 });
      expect(alpha.tasks[0]).toMatchObject({
        id: 'alpha-task',
        presetId: 'alpha-daily',
        kind: 'daily',
        position: 0,
      });
      const calls = repo.replacePresetTasks.mock.calls.length;
      return service.listPresets().then(() => {
        expect(repo.replacePresetTasks.mock.calls.length).toBe(calls);
      });
    });
  });

  it('refreshes changed catalog metadata and templates while keeping enabled', async () => {
    const { repo, service } = setup();
    await service.listPresets();
    repo.updatePreset('alpha-daily', { enabled: true });

    const changed = CATALOG.map((preset) =>
      preset.id === 'alpha-daily'
        ? {
            ...preset,
            name: 'Alpha daily v2',
            tasks: [{ ...preset.tasks[0], prompt: 'do alpha v2' }],
          }
        : preset
    );
    const second = createPresetService({
      repo,
      rules,
      catalog: changed,
      workspace: { ensureTaskWorkspace: vi.fn(() => null) },
      now: () => NOW,
    });
    const listed = await second.listPresets();
    const alpha = presetById(listed, 'alpha-daily');
    expect(alpha.name).toBe('Alpha daily v2');
    expect(alpha.enabled).toBe(true);
    expect(alpha.tasks[0].prompt).toBe('do alpha v2');
    expect(alpha.tasks[0].id).toBe('alpha-task');
  });
});

describe('discovery scoping (§10.1)', () => {
  it('keeps builtin presets visible in every project', async () => {
    const { service } = setup();
    const foreign = await service.getPreset('alpha-daily', { projectPath: OTHER });
    expect(foreign.ok).toBe(true);
  });

  it('hides a custom preset from other projects and shows it at home', async () => {
    const { repo, service } = setup();
    const task = repo.createTask({
      title: 'a',
      prompt: 'p',
      projectPath: PROJECT,
      kind: 'daily',
      ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' }),
      nextRunAt: iso(NOW),
      enabled: true,
    });
    const created = await service.createCustomPreset({ name: 'Mine', projectPath: PROJECT, taskIds: [task.id] });
    expect(created.ok).toBe(true);

    expect((await service.getPreset(created.preset.id, { projectPath: PROJECT })).ok).toBe(true);
    expect((await service.getPreset(created.preset.id, { projectPath: OTHER })).code).toBe('not_found');
    expect((await service.getPreset(created.preset.id)).ok).toBe(true);

    const home = await service.listPresets({ projectPath: PROJECT });
    expect(home.presets.some((preset) => preset.id === created.preset.id)).toBe(true);
    const foreign = await service.listPresets({ projectPath: OTHER });
    expect(foreign.presets.some((preset) => preset.id === created.preset.id)).toBe(false);
  });

  it('scopes update/setEnabled/delete to the owning project', async () => {
    const { repo, service } = setup();
    const task = repo.createTask({
      title: 'a',
      prompt: 'p',
      projectPath: PROJECT,
      kind: 'daily',
      ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' }),
      nextRunAt: iso(NOW),
      enabled: true,
    });
    const created = await service.createCustomPreset({ name: 'Mine', projectPath: PROJECT, taskIds: [task.id] });

    expect((await service.updatePreset(created.preset.id, { name: 'x' }, { projectPath: OTHER })).code).toBe(
      'not_found'
    );
    expect((await service.setPresetEnabled(created.preset.id, true, { projectPath: OTHER })).code).toBe(
      'not_found'
    );
    expect((await service.deletePreset(created.preset.id, {}, { projectPath: OTHER })).code).toBe('not_found');
    expect((await service.getPreset(created.preset.id, { projectPath: PROJECT })).ok).toBe(true);
  });
});

describe('installPreset (§10.3)', () => {
  it('requires a project path and a known preset', async () => {
    const { service } = setup();
    expect((await service.installPreset('alpha-daily')).code).toBe('invalid_input');
    expect((await service.installPreset('alpha-daily', { projectPath: '' })).code).toBe('invalid_input');
    expect((await service.installPreset('nope', { projectPath: PROJECT })).code).toBe('not_found');
  });

  it('materializes one real task per template with links and next runs', async () => {
    const { repo, service } = setup();
    const result = await service.installPreset('alpha-daily', { projectPath: PROJECT });
    expect(result.ok).toBe(true);
    expect(result.created).toHaveLength(1);
    expect(result.updated).toHaveLength(0);
    expect(result.skipped).toEqual([]);
    expect(result.preset.enabled).toBe(true);

    const row = repo._tasks.get(result.created[0]);
    expect(row).toMatchObject({
      project_path: PROJECT,
      preset_id: 'alpha-daily',
      preset_task_id: 'alpha-task',
      enabled: 1,
    });
    expect(row.next_run_at).toBe('2030-06-04T09:00:00.000Z');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ presetId: 'alpha-daily', presetTaskId: 'alpha-task' });
  });

  it('is idempotent: a second install updates instead of duplicating', async () => {
    const { repo, service } = setup();
    const first = await service.installPreset('alpha-daily', { projectPath: PROJECT });
    const second = await service.installPreset('alpha-daily', { projectPath: PROJECT });

    expect(second.created).toEqual([]);
    expect(second.updated).toEqual(first.created);
    expect(repo._tasks.size).toBe(1);
  });

  it('installs disabled when asked and keeps nextRunAt null', async () => {
    const { repo, service } = setup();
    const result = await service.installPreset('alpha-daily', { projectPath: PROJECT, enabled: false });
    expect(result.preset.enabled).toBe(false);
    expect(result.tasks[0].enabled).toBe(false);
    expect(result.tasks[0].nextRunAt).toBeNull();
    expect(repo._tasks.get(result.created[0]).next_run_at).toBeNull();
  });

  it('installs a preset into any project, even one that does not own it', async () => {
    const { repo, service } = setup();
    const task = repo.createTask({
      title: 'a',
      prompt: 'p',
      projectPath: PROJECT,
      kind: 'interval',
      ruleJson: JSON.stringify({ kind: 'interval', everySeconds: 3600, anchorMs: NOW }),
      nextRunAt: iso(NOW + 3600000),
      enabled: true,
    });
    const created = await service.createCustomPreset({ name: 'Mine', projectPath: PROJECT, taskIds: [task.id] });

    const installed = await service.installPreset(created.preset.id, { projectPath: OTHER });
    expect(installed.ok).toBe(true);
    expect(installed.created).toHaveLength(1);
    const row = repo._tasks.get(installed.created[0]);
    expect(row.project_path).toBe(OTHER);
    // The interval clock restarts in the target project.
    expect(row.next_run_at).toBe(iso(NOW + 3600000));
    expect(installed.preset.installedProjects).toEqual([path.resolve(OTHER)]);
  });

  it('skips templates whose rule has no upcoming run and reports their ids', async () => {
    const { service } = setup();
    const result = await service.installPreset('delta-exhausted', { projectPath: PROJECT });
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(['delta-never']);
    expect(result.created).toEqual([]);
  });

  it('tracks installed projects across installs', async () => {
    const { service } = setup();
    await service.installPreset('beta-weekly', { projectPath: PROJECT });
    await service.installPreset('beta-weekly', { projectPath: OTHER });
    const found = await service.getPreset('beta-weekly');
    expect(found.preset.installedProjects.sort()).toEqual([path.resolve(PROJECT), path.resolve(OTHER)].sort());
    expect(found.preset.enabled).toBe(true);
  });
});

describe('setPresetEnabled (§10.3)', () => {
  it('flips the preset and every linked task', async () => {
    const { repo, service } = setup();
    const installed = await service.installPreset('gamma-interval', { projectPath: PROJECT, enabled: false });
    const taskId = installed.created[0];
    repo._tasks.get(taskId).enabled = 0;
    repo._tasks.get(taskId).next_run_at = null;

    const enabled = await service.setPresetEnabled('gamma-interval', true, { projectPath: PROJECT });
    expect(enabled.ok).toBe(true);
    expect(enabled.preset.enabled).toBe(true);
    expect(enabled.tasks[0].enabled).toBe(true);
    expect(enabled.tasks[0].nextRunAt).toBe(iso(NOW + 3600000));

    const disabled = await service.setPresetEnabled('gamma-interval', false, { projectPath: PROJECT });
    expect(disabled.preset.enabled).toBe(false);
    expect(disabled.tasks[0].enabled).toBe(false);
    expect(disabled.tasks[0].nextRunAt).toBeNull();
  });

  it('records the flag even when the preset is not installed yet', async () => {
    const { service } = setup();
    const result = await service.setPresetEnabled('alpha-daily', true);
    expect(result.ok).toBe(true);
    expect(result.preset.enabled).toBe(true);
    expect(result.tasks).toEqual([]);
  });

  it('validates input and unknown ids', async () => {
    const { service } = setup();
    expect((await service.setPresetEnabled('alpha-daily', 'yes')).code).toBe('invalid_input');
    expect((await service.setPresetEnabled('nope', true)).code).toBe('not_found');
  });
});

describe('createCustomPreset (§10.3)', () => {
  function seedTasks(repo) {
    return [1, 2].map((n) =>
      repo.createTask({
        title: `task ${n}`,
        prompt: `prompt ${n}`,
        projectPath: PROJECT,
        kind: 'daily',
        ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' }),
        nextRunAt: iso(NOW),
        enabled: true,
        command: n === 2 ? 'echo gate' : undefined,
        commandTimeoutSeconds: n === 2 ? 30 : undefined,
      })
    );
  }

  it('snapshots tasks in order with position and enabled false', async () => {
    const { repo, service } = setup();
    const tasks = seedTasks(repo);
    const result = await service.createCustomPreset({
      name: 'My bundle',
      description: 'desc',
      projectPath: PROJECT,
      taskIds: [tasks[1].id, tasks[0].id],
    });
    expect(result.ok).toBe(true);
    expect(result.preset).toMatchObject({ source: 'custom', enabled: false, projectPath: PROJECT, taskCount: 2 });
    expect(result.preset.tasks.map((task) => task.title)).toEqual(['task 2', 'task 1']);
    expect(result.preset.tasks.map((task) => task.position)).toEqual([0, 1]);
    expect(result.preset.tasks[0].command).toBe('echo gate');
    expect(result.preset.tasks[0].commandTimeoutSeconds).toBe(30);
  });

  it('validates name, project and task ids', async () => {
    const { repo, service } = setup();
    const tasks = seedTasks(repo);
    expect((await service.createCustomPreset({ projectPath: PROJECT, taskIds: [tasks[0].id] })).code).toBe(
      'invalid_input'
    );
    expect((await service.createCustomPreset({ name: 'x', taskIds: [tasks[0].id] })).code).toBe('invalid_input');
    expect((await service.createCustomPreset({ name: 'x', projectPath: PROJECT, taskIds: [] })).code).toBe(
      'no_tasks'
    );
    expect(
      (await service.createCustomPreset({ name: 'x', projectPath: OTHER, taskIds: [tasks[0].id] })).code
    ).toBe('not_found');
    expect(
      (await service.createCustomPreset({ name: 'x', projectPath: PROJECT, taskIds: ['missing'] })).code
    ).toBe('not_found');
  });
});

describe('updatePreset (§10.3)', () => {
  it('updates name/description/icon on a custom preset', async () => {
    const { repo, service } = setup();
    const task = repo.createTask({
      title: 'a',
      prompt: 'p',
      projectPath: PROJECT,
      kind: 'daily',
      ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' }),
      nextRunAt: iso(NOW),
      enabled: true,
    });
    const created = await service.createCustomPreset({ name: 'Mine', projectPath: PROJECT, taskIds: [task.id] });

    const updated = await service.updatePreset(created.preset.id, { name: 'Renamed', icon: 'Star' });
    expect(updated.ok).toBe(true);
    expect(updated.preset).toMatchObject({ name: 'Renamed', icon: 'Star' });
  });

  it('rejects builtin presets and unknown ids', async () => {
    const { service } = setup();
    expect((await service.updatePreset('alpha-daily', { name: 'x' })).code).toBe('builtin_preset');
    expect((await service.updatePreset('nope', { name: 'x' })).code).toBe('not_found');
  });

  it('rejects an empty patch', async () => {
    const { repo, service } = setup();
    const task = repo.createTask({
      title: 'a',
      prompt: 'p',
      projectPath: PROJECT,
      kind: 'daily',
      ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' }),
      nextRunAt: iso(NOW),
      enabled: true,
    });
    const created = await service.createCustomPreset({ name: 'Mine', projectPath: PROJECT, taskIds: [task.id] });
    expect((await service.updatePreset(created.preset.id, {})).code).toBe('invalid_input');
  });
});

describe('deletePreset (§10.3)', () => {
  async function installCustom(repo, service) {
    const task = repo.createTask({
      title: 'a',
      prompt: 'p',
      projectPath: PROJECT,
      kind: 'daily',
      ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' }),
      nextRunAt: iso(NOW),
      enabled: true,
    });
    const created = await service.createCustomPreset({ name: 'Mine', projectPath: PROJECT, taskIds: [task.id] });
    const installed = await service.installPreset(created.preset.id, { projectPath: PROJECT });
    return { presetId: created.preset.id, installedTaskId: installed.created[0] };
  }

  it('drops a custom preset and purges its tasks by default', async () => {
    const { repo, service } = setup();
    const { presetId, installedTaskId } = await installCustom(repo, service);
    const result = await service.deletePreset(presetId, {});
    expect(result).toMatchObject({ ok: true, id: presetId, deleted: true, source: 'custom', removedTasks: 1 });
    expect(repo.getPreset(presetId)).toBeUndefined();
    expect(repo._tasks.has(installedTaskId)).toBe(false);
  });

  it('keeps the installed tasks when purge is false', async () => {
    const { repo, service } = setup();
    const { presetId, installedTaskId } = await installCustom(repo, service);
    const result = await service.deletePreset(presetId, { purge: false });
    expect(result.removedTasks).toBe(0);
    expect(repo.getPreset(presetId)).toBeUndefined();
    expect(repo._tasks.has(installedTaskId)).toBe(true);
  });

  it('uninstalls a builtin preset but keeps the catalog row and templates', async () => {
    const { repo, service } = setup();
    const installed = await service.installPreset('alpha-daily', { projectPath: PROJECT });
    const result = await service.deletePreset('alpha-daily', {});
    expect(result).toMatchObject({ ok: true, source: 'builtin', removedTasks: 1 });
    expect(repo._tasks.has(installed.created[0])).toBe(false);
    const row = repo.getPreset('alpha-daily');
    expect(row).toBeDefined();
    expect(row.enabled).toBe(0);
    expect(repo.listPresetTasks('alpha-daily')).toHaveLength(1);
  });

  it('is not_found for unknown or out-of-scope custom presets', async () => {
    const { service } = setup();
    expect((await service.deletePreset('nope')).code).toBe('not_found');
  });
});

const AUTODOC_PRESET_ID = 'auto-doc';
const AUTODOC_TEMPLATE_ID = 'auto-doc-docs-refresh';

function shippedAutoDocService() {
  const repo = makeRepo();
  const service = createPresetService({
    repo,
    rules,
    catalog: loadBuiltinCatalog(),
    workspace: { ensureTaskWorkspace: vi.fn(() => null) },
    now: () => NOW,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  return { repo, service };
}

function autoDocTemplate() {
  return loadBuiltinCatalog().find((entry) => entry.id === AUTODOC_PRESET_ID).tasks[0];
}

describe('builtin auto-doc preset (docs §11.3)', () => {
  it('loads the shipped catalog with a globally unique template id', () => {
    const catalog = loadBuiltinCatalog();
    const ids = catalog.flatMap((entry) => entry.tasks.map((task) => task.id));
    expect(new Set(ids).size).toBe(ids.length);

    const preset = catalog.find((entry) => entry.id === AUTODOC_PRESET_ID);
    expect(preset, 'auto-doc.json must ship in the builtin catalog').toBeDefined();
    expect(preset.tasks).toHaveLength(1);
    const [template] = preset.tasks;
    expect(template.id).toBe(AUTODOC_TEMPLATE_ID);
    expect(template.rule).toEqual({ kind: 'daily', time: '21:00', timeZone: 'Asia/Shanghai' });
    expect(typeof template.command).toBe('string');
    expect(template.command.length).toBeGreaterThan(0);
    expect(template.prompt).toContain('CLAUDE.md');
    expect(template.prompt).toContain('SCHEDULED_TASK_DIR');
  });

  it('lists the preset and installs one enabled task', async () => {
    const { repo, service } = shippedAutoDocService();
    const listed = await service.listPresets();
    expect(listed.ok).toBe(true);
    const preset = listed.presets.find((entry) => entry.id === AUTODOC_PRESET_ID);
    expect(preset).toMatchObject({ source: 'builtin', taskCount: 1 });
    expect(preset.tasks[0].id).toBe(AUTODOC_TEMPLATE_ID);

    const installed = await service.installPreset(AUTODOC_PRESET_ID, { projectPath: PROJECT });
    expect(installed.ok).toBe(true);
    expect(installed.created).toHaveLength(1);
    expect(installed.skipped).toEqual([]);
    const row = repo._tasks.get(installed.created[0]);
    expect(row).toMatchObject({
      project_path: PROJECT,
      preset_id: AUTODOC_PRESET_ID,
      preset_task_id: AUTODOC_TEMPLATE_ID,
      enabled: 1,
      command_timeout_seconds: 60,
    });
    // The installed task really carries the self-contained script gate (node -e '...').
    expect(row.command).toContain('autodoc-cursor.json');
    expect(row.command.startsWith("node -e '")).toBe(true);
    expect(row.command.split("'")).toHaveLength(3);
    // daily 21:00 Asia/Shanghai; NOW is 2030-06-03T12:00:00Z = 20:00 in Shanghai.
    expect(row.next_run_at).toBe('2030-06-03T13:00:00.000Z');
  });

  const itPosix = process.platform === 'win32' ? it.skip : it;

  itPosix('gate skips while the conversations are unchanged and wakes on a newer transcript', () => {
    const template = autoDocTemplate();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodoc-preset-'));
    try {
      const home = path.join(tmp, 'home');
      const project = path.join(tmp, 'project');
      const stateDir = path.join(tmp, 'state');
      fs.mkdirSync(project, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      const sessions = path.join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(sessions, { recursive: true });

      const runGate = () => {
        const env = {
          ...process.env,
          PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''),
          HOME: home,
          SCHEDULED_TASK_PROJECT: project,
          // §10.4: the cursor now lives in the task root.
          SCHEDULED_TASK_DIR: stateDir,
        };
        const stdout = execFileSync('sh', ['-c', template.command], { cwd: project, env, encoding: 'utf8' });
        return JSON.parse(stdout.trim());
      };

      // No transcript at all and no cursor: skip, never an error and never a model call.
      const empty = runGate();
      expect(empty.skip).toBe(true);
      expect(empty.reason).toMatch(/no new conversations since/);

      // A transcript appears: the gate hands the agent the refresh prompt.
      const first = path.join(sessions, 'session-a.jsonl');
      fs.writeFileSync(first, '{"type":"user"}\n');
      const t1 = Date.parse('2026-10-30T10:00:00Z') / 1000;
      fs.utimesSync(first, t1, t1);
      const woke = runGate();
      expect(typeof woke.prompt).toBe('string');
      expect(woke.prompt).toContain('CLAUDE.md');
      expect(woke.prompt).toContain('docs/');
      expect(woke.prompt).toContain(sessions);

      // The cursor caught up with the newest transcript: skip with its timestamp.
      const cursorMs = fs.statSync(first).mtimeMs;
      fs.writeFileSync(
        path.join(stateDir, 'autodoc-cursor.json'),
        JSON.stringify({ lastMessageMs: cursorMs, updatedAt: new Date(cursorMs).toISOString() })
      );
      expect(runGate()).toEqual({
        skip: true,
        reason: 'no new conversations since ' + new Date(cursorMs).toISOString(),
      });

      // A newer transcript wakes it again.
      const second = path.join(sessions, 'session-b.jsonl');
      fs.writeFileSync(second, '{"type":"user"}\n');
      const t2 = Date.parse('2026-10-31T09:00:00Z') / 1000;
      fs.utimesSync(second, t2, t2);
      const again = runGate();
      expect(typeof again.prompt).toBe('string');
      expect(again.prompt).toContain(new Date(fs.statSync(second).mtimeMs).toISOString());
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('parameters (§12)', () => {
  const PARAM_CATALOG = [
    {
      id: 'param-preset',
      name: 'Param preset',
      tasks: [
        {
          id: 'param-task',
          title: 'Param task',
          prompt: 'do it',
          rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
          params: [
            { name: 'region', type: 'string', default: 'eu' },
            { name: 'threshold', type: 'number', default: 3 },
          ],
        },
      ],
    },
  ];

  it('seeds template params and copies them onto installed tasks', async () => {
    const { repo, service } = setup(PARAM_CATALOG);

    const installed = await service.installPreset('param-preset', { projectPath: PROJECT });

    expect(installed.ok).toBe(true);
    const task = repo._tasks.get(installed.tasks[0].id);
    expect(JSON.parse(task.params_json)).toEqual(PARAM_CATALOG[0].tasks[0].params);
    expect(installed.tasks[0].params).toEqual(PARAM_CATALOG[0].tasks[0].params);
  });

  it('applies install overrides to every template that declares the name (unknown names ignored)', async () => {
    const { repo, service } = setup(PARAM_CATALOG);

    const installed = await service.installPreset('param-preset', {
      projectPath: PROJECT,
      params: { region: 'us', unknown: 'x' },
    });

    expect(installed.ok).toBe(true);
    const task = repo._tasks.get(installed.tasks[0].id);
    expect(JSON.parse(task.params_json)).toEqual([
      { name: 'region', type: 'string', default: 'us' },
      { name: 'threshold', type: 'number', default: 3 },
    ]);
  });

  it('rejects an uncoercible install override', async () => {
    const { service } = setup(PARAM_CATALOG);

    const installed = await service.installPreset('param-preset', {
      projectPath: PROJECT,
      params: { threshold: 'abc' },
    });

    expect(installed).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects an invalid template ParamDef with invalid_catalog', () => {
    const result = validateBuiltinPreset({
      id: 'bad-preset',
      name: 'Bad',
      tasks: [
        {
          id: 'bad-task',
          title: 'T',
          prompt: 'p',
          rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
          params: [{ name: '1bad' }],
        },
      ],
    });

    expect(result).toMatchObject({ ok: false, code: 'invalid_catalog' });
  });

  it('rejects an invalid override before materializing anything (no partial install)', async () => {
    const catalog = [
      {
        id: 'two-templates',
        name: 'Two templates',
        tasks: [
          {
            id: 'tpl-a',
            title: 'A',
            prompt: 'p',
            rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
            params: [{ name: 'region', type: 'string', default: 'eu' }],
          },
          {
            id: 'tpl-b',
            title: 'B',
            prompt: 'p',
            rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
            params: [{ name: 'count', type: 'number', default: 2 }],
          },
        ],
      },
    ];
    const { repo, service } = setup(catalog);

    const result = await service.installPreset('two-templates', {
      projectPath: PROJECT,
      params: { count: 'abc' },
    });

    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    // The first template would have succeeded; nothing may be materialized.
    expect(repo._tasks.size).toBe(0);
    expect(repo._presets.get('two-templates').enabled).toBe(0);
  });

  it('keeps the parameter contract when a custom preset is installed in another project', async () => {
    const { repo, service } = setup();
    const paramsJson = JSON.stringify([
      { name: 'region', type: 'string', default: 'eu' },
      { name: 'threshold', type: 'number', default: 3 },
    ]);
    const task = repo.createTask({
      title: 't',
      prompt: 'p',
      projectPath: PROJECT,
      kind: 'daily',
      ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' }),
      paramsJson,
    });
    const created = await service.createCustomPreset({
      name: 'Mine',
      projectPath: PROJECT,
      taskIds: [task.id],
    });

    const installed = await service.installPreset(created.preset.id, { projectPath: OTHER });
    expect(installed.ok).toBe(true);
    expect(JSON.parse(repo._tasks.get(installed.tasks[0].id).params_json)).toEqual([
      { name: 'region', type: 'string', default: 'eu' },
      { name: 'threshold', type: 'number', default: 3 },
    ]);
  });

  it('snapshots task params into a custom preset', async () => {
    const { repo, service } = setup();
    const paramsJson = JSON.stringify([{ name: 'region', type: 'string', default: 'eu' }]);
    const task = repo.createTask({
      title: 't',
      prompt: 'p',
      projectPath: PROJECT,
      kind: 'daily',
      ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' }),
      paramsJson,
    });

    const created = await service.createCustomPreset({
      name: 'Mine',
      projectPath: PROJECT,
      taskIds: [task.id],
    });

    expect(created.ok).toBe(true);
    expect(created.preset.tasks[0].params).toEqual([
      { name: 'region', type: 'string', default: 'eu' },
    ]);
    expect(JSON.parse(repo._presetTasks.get(created.preset.id)[0].params_json)).toEqual([
      { name: 'region', type: 'string', default: 'eu' },
    ]);
  });
});

describe('SCHEDULED_TASK_PRESET_DIR (catalog directory override)', () => {
  afterEach(() => {
    delete process.env.SCHEDULED_TASK_PRESET_DIR;
    vi.resetModules();
  });

  it('keeps the shipped default when unset or blank', async () => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.SCHEDULED_TASK_PRESET_DIR;
      else process.env.SCHEDULED_TASK_PRESET_DIR = value;
      vi.resetModules();
      const mod = await import('./presets.js');
      expect(mod.BUILTIN_PRESET_DIR).toBe(path.join(BUILTIN_PRESET_DIR));
      expect(mod.BUILTIN_PRESET_DIR.endsWith(path.join('presets', 'builtin'))).toBe(true);
      expect(mod.loadBuiltinCatalog().length).toBeGreaterThan(0);
    }
  });

  it('honours an explicit directory (it becomes the whole catalog)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-preset-dir-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'zeta.json'),
        JSON.stringify({
          id: 'zeta',
          name: 'Zeta',
          tasks: [
            {
              id: 'zeta-task',
              title: 'Zeta task',
              prompt: 'p',
              rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
            },
          ],
        })
      );
      process.env.SCHEDULED_TASK_PRESET_DIR = dir;
      vi.resetModules();
      const mod = await import('./presets.js');

      expect(mod.BUILTIN_PRESET_DIR).toBe(path.resolve(dir));
      expect(mod.loadBuiltinCatalog().map((preset) => preset.id)).toEqual(['zeta']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades like a missing catalog directory when the path does not exist', async () => {
    process.env.SCHEDULED_TASK_PRESET_DIR = path.join(os.tmpdir(), 'scheduled-preset-missing-' + Date.now());
    vi.resetModules();
    const mod = await import('./presets.js');

    expect(() => mod.loadBuiltinCatalog()).not.toThrow();
    expect(mod.loadBuiltinCatalog()).toEqual([]);
  });
});

