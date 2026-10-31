import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pass-through SDK mock so we can invoke the tool handlers directly.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name, description, schema, handler, extras) => ({ name, description, schema, handler, extras }),
}));

import { createScheduleTools, SCHEDULE_TOOL_NAMES, isScheduleToolsEnabled } from './tools.js';
import * as rules from './rules.js';
import { PREDEFINED_ENV_NAMES, PREDEFINED_TASK_VARS, SESSION_ID_NOTE } from './params.js';

const NOW = Date.parse('2030-06-03T12:00:00.000Z'); // a Monday
const PROJECT = '/tmp/project-alpha';
const OTHER = '/tmp/project-beta';
const iso = (ms) => new Date(ms).toISOString();

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
    created_at: stamp,
    updated_at: stamp,
  };
}

function makeRunRow(taskId, override = {}) {
  return {
    id: 'run-1',
    task_id: taskId,
    status: 'running',
    trigger: 'manual',
    scheduled_for: null,
    started_at: iso(NOW),
    finished_at: null,
    session_id: null,
    output: null,
    error: null,
    ...override,
  };
}

function makeRepo() {
  const tasks = new Map();
  const runs = new Map();
  let idSeq = 0;

  return {
    createTask: vi.fn((input) => {
      const row = makeTaskRow(input, `task-${++idSeq}`);
      tasks.set(row.id, row);
      return row;
    }),
    getTask: vi.fn((id) => tasks.get(id)),
    listTasks: vi.fn((options = {}) => {
      let rows = [...tasks.values()];
      if (typeof options.userId === 'number') rows = rows.filter((r) => r.user_id === options.userId);
      if (options.status === 'active') rows = rows.filter((r) => !!r.enabled);
      if (options.status === 'paused') rows = rows.filter((r) => !r.enabled);
      return rows;
    }),
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
      row.updated_at = iso(NOW);
      return row;
    }),
    deleteTask: vi.fn((id) => tasks.delete(id)),
    listRuns: vi.fn((taskId, limit = 20, offset = 0) =>
      (runs.get(taskId) || []).slice(offset, offset + limit)
    ),
    countRuns: vi.fn((taskId) => (runs.get(taskId) || []).length),
    _tasks: tasks,
    _runs: runs,
    _seedRun(taskId, override = {}) {
      const row = makeRunRow(taskId, override);
      const list = runs.get(taskId) || [];
      list.unshift(row);
      runs.set(taskId, list);
      return row;
    },
  };
}

function setup(depsOverrides = {}) {
  const repo = makeRepo();
  const runNow = vi.fn(async (taskId) => ({ run: makeRunRow(taskId) }));
  const tools = createScheduleTools({
    projectPath: PROJECT,
    deps: { repo, runNow, rules, now: () => NOW, workspace: false, ...depsOverrides },
  });
  const byName = Object.fromEntries(tools.map((definition) => [definition.name, definition]));

  async function callRaw(name, args) {
    const definition = byName[name];
    expect(definition, `tool ${name} is registered`).toBeDefined();
    const result = await definition.handler(args);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    return JSON.parse(result.content[0].text);
  }

  return { repo, runNow, tools, byName, call: callRaw };
}

beforeEach(() => {
  delete process.env.SCHEDULED_TASKS_TOOLS;
});

describe('tool registration', () => {
  it('registers the twelve schedule_* tools in contract order', () => {
    const { tools } = setup();
    expect(tools.map((definition) => definition.name)).toEqual(SCHEDULE_TOOL_NAMES);
    expect(SCHEDULE_TOOL_NAMES).toHaveLength(12);
    for (const definition of tools) {
      expect(typeof definition.handler).toBe('function');
      expect(definition.description).toBeTruthy();
    }
  });

  it('honours SCHEDULED_TASKS_TOOLS=0', () => {
    expect(isScheduleToolsEnabled()).toBe(true);
    process.env.SCHEDULED_TASKS_TOOLS = '0';
    expect(isScheduleToolsEnabled()).toBe(false);
    process.env.SCHEDULED_TASKS_TOOLS = 'false';
    expect(isScheduleToolsEnabled()).toBe(false);
    process.env.SCHEDULED_TASKS_TOOLS = '1';
    expect(isScheduleToolsEnabled()).toBe(true);
  });
});

describe('schedule_create', () => {
  it('attributes the task to the session user when one is known', async () => {
    const repo = makeRepo();
    const tools = createScheduleTools({
      projectPath: PROJECT,
      userId: 7,
      deps: {
        repo,
        runNow: vi.fn(async (taskId) => ({ run: makeRunRow(taskId) })),
        rules,
        now: () => NOW,
        workspace: false,
      },
    });
    const create = tools.find((definition) => definition.name === 'schedule_create');

    await create.handler({ title: 'attributed', prompt: 'p', every_seconds: 300 });

    expect(repo.createTask).toHaveBeenCalledTimes(1);
    expect(repo.createTask.mock.calls[0][0].userId).toBe(7);
  });

  it('creates a task for every selector form', async () => {
    const { call, repo } = setup();

    const after = await call('schedule_create', { title: 'a', prompt: 'p', after_seconds: 300 });
    expect(after).toMatchObject({ kind: 'once', projectPath: PROJECT, enabled: true, provider: 'claude' });
    expect(after.rule.at).toBe(iso(NOW + 300000));
    expect(after.nextRunAt).toBe(iso(NOW + 300000));

    const at = await call('schedule_create', { title: 'b', prompt: 'p', at: '2030-12-01T00:00:00Z' });
    expect(at.rule).toMatchObject({ kind: 'once', at: '2030-12-01T00:00:00.000Z' });
    expect(at.nextRunAt).toBe('2030-12-01T00:00:00.000Z');

    const every = await call('schedule_create', { title: 'c', prompt: 'p', every_seconds: 120 });
    expect(every.rule).toMatchObject({ kind: 'interval', everySeconds: 120, anchorMs: NOW });
    expect(every.nextRunAt).toBe(iso(NOW + 120000));

    const daily = await call('schedule_create', {
      title: 'd',
      prompt: 'p',
      daily: { time: '09:30', time_zone: 'UTC' },
    });
    expect(daily.rule).toMatchObject({ kind: 'daily', time: '09:30', timeZone: 'UTC', hour: 9, minute: 30 });
    expect(daily.nextRunAt).toBe('2030-06-04T09:30:00.000Z');

    const weekly = await call('schedule_create', {
      title: 'e',
      prompt: 'p',
      weekly: { time: '08:00', time_zone: 'UTC', weekdays: [1, 3] },
    });
    expect(weekly.rule).toMatchObject({ kind: 'weekly', weekdays: [1, 3], time: '08:00' });
    expect(weekly.nextRunAt).toBe('2030-06-05T08:00:00.000Z');

    const cron = await call('schedule_create', {
      title: 'f',
      prompt: 'p',
      cron: { expression: '*/15 * * * *', time_zone: 'UTC' },
    });
    expect(cron.rule).toMatchObject({ kind: 'cron', expression: '*/15 * * * *', timeZone: 'UTC' });
    expect(cron.nextRunAt).toBe('2030-06-03T12:15:00.000Z');

    expect(repo._tasks.size).toBe(6);
  });

  it('defaults project_path to the session project and accepts an override', async () => {
    const { call } = setup();
    const mine = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });
    const other = await call('schedule_create', {
      title: 'b',
      prompt: 'p',
      project_path: OTHER,
      every_seconds: 60,
    });
    expect(mine.projectPath).toBe(PROJECT);
    expect(other.projectPath).toBe(OTHER);
  });

  it('requires exactly one selector', async () => {
    const { call } = setup();
    expect(await call('schedule_create', { title: 'x', prompt: 'p' })).toMatchObject({
      code: 'invalid_input',
    });
    expect(
      await call('schedule_create', {
        title: 'x',
        prompt: 'p',
        every_seconds: 60,
        at: '2031-01-01T00:00:00Z',
      })
    ).toMatchObject({ code: 'invalid_input' });
  });

  it('validates the rule through the shared rules engine codes', async () => {
    const { call } = setup();
    expect((await call('schedule_create', { title: 'x', prompt: 'p', every_seconds: 10 })).code).toBe(
      'invalid_interval'
    );
    expect(
      (
        await call('schedule_create', {
          title: 'x',
          prompt: 'p',
          daily: { time: '09:00', time_zone: 'Not/AZone' },
        })
      ).code
    ).toBe('invalid_time_zone');
    expect(
      (await call('schedule_create', { title: 'x', prompt: 'p', at: '2020-01-01T00:00:00Z' })).code
    ).toBe('invalid_schedule_time');
    expect(
      (
        await call('schedule_create', {
          title: 'x',
          prompt: 'p',
          cron: { expression: 'not a cron', time_zone: 'UTC' },
        })
      ).code
    ).toBe('invalid_cron');
  });

  it('requires title and prompt', async () => {
    const { call } = setup();
    expect((await call('schedule_create', { prompt: 'p', every_seconds: 60 })).code).toBe('invalid_input');
    expect((await call('schedule_create', { title: 'x', every_seconds: 60 })).code).toBe('invalid_input');
  });
});

describe('schedule_list', () => {
  it('scopes to the session project and honours include_paused', async () => {
    const { call } = setup();
    await call('schedule_create', { title: 'mine', prompt: 'p', every_seconds: 60 });
    await call('schedule_create', { title: 'other', prompt: 'p', project_path: OTHER, every_seconds: 60 });
    const paused = await call('schedule_create', { title: 'paused', prompt: 'p', every_seconds: 60 });
    await call('schedule_pause', { id: paused.id });

    const active = await call('schedule_list', {});
    expect(active.tasks.map((task) => task.title)).toEqual(['mine']);

    const all = await call('schedule_list', { include_paused: true });
    expect(all.tasks.map((task) => task.title).sort()).toEqual(['mine', 'paused']);
  });

  it('returns an empty list when the project has no tasks', async () => {
    const { call } = setup();
    expect(await call('schedule_list', {})).toEqual({ tasks: [] });
  });
});

describe('schedule_get', () => {
  it('returns the task with its five most recent runs', async () => {
    const { call, repo } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });
    for (let i = 0; i < 7; i += 1) repo._seedRun(created.id, { output: 'run-' + i, status: 'success' });

    const got = await call('schedule_get', { id: created.id });
    expect(got.task.id).toBe(created.id);
    expect(got.recent_runs).toHaveLength(5);
    expect(got.recent_runs[0]).toMatchObject({ taskId: created.id, status: 'success', output: 'run-6' });
  });

  it('returns not_found for an unknown id', async () => {
    const { call } = setup();
    expect(await call('schedule_get', { id: 'nope' })).toMatchObject({ code: 'not_found' });
  });
});

describe('schedule_update', () => {
  it('updates title and prompt', async () => {
    const { call } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    const updated = await call('schedule_update', { id: created.id, title: 'renamed', prompt: 'new prompt' });
    expect(updated).toMatchObject({ id: created.id, title: 'renamed', prompt: 'new prompt' });
  });

  it('replaces the schedule from a selector', async () => {
    const { call } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    const updated = await call('schedule_update', { id: created.id, every_seconds: 300 });
    expect(updated.kind).toBe('interval');
    expect(updated.rule).toMatchObject({ kind: 'interval', everySeconds: 300, anchorMs: NOW });
    expect(updated.nextRunAt).toBe(iso(NOW + 300000));
  });

  it('rejects an empty patch, ambiguous selectors and bad rules', async () => {
    const { call } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    expect((await call('schedule_update', { id: created.id })).code).toBe('invalid_input');
    expect(
      (await call('schedule_update', { id: created.id, every_seconds: 60, at: '2031-01-01T00:00:00Z' })).code
    ).toBe('invalid_input');
    expect((await call('schedule_update', { id: created.id, every_seconds: 5 })).code).toBe('invalid_interval');
    expect((await call('schedule_update', { id: 'missing', title: 'x' })).code).toBe('not_found');
  });
});

describe('pause / resume', () => {
  it('pauses (clears nextRunAt) and resumes (recomputes it)', async () => {
    const { call } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    const paused = await call('schedule_pause', { id: created.id });
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });

    const resumed = await call('schedule_resume', { id: created.id });
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt).toBe(iso(NOW + 60000));
  });

  it('is not_found for an unknown id', async () => {
    const { call } = setup();
    expect((await call('schedule_pause', { id: 'nope' })).code).toBe('not_found');
    expect((await call('schedule_resume', { id: 'nope' })).code).toBe('not_found');
  });
});

describe('schedule_run', () => {
  it('starts a manual run', async () => {
    const { call, runNow } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    const ran = await call('schedule_run', { id: created.id });
    expect(runNow).toHaveBeenCalledWith(created.id);
    expect(ran.run).toMatchObject({ id: 'run-1', taskId: created.id, status: 'running', trigger: 'manual' });
  });

  it('reports in_flight and internal errors without throwing', async () => {
    const { call, runNow } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    runNow.mockResolvedValueOnce({ error: 'in_flight' });
    expect(await call('schedule_run', { id: created.id })).toMatchObject({ code: 'in_flight' });

    runNow.mockRejectedValueOnce(new Error('boom'));
    const failed = await call('schedule_run', { id: created.id });
    expect(failed.code).toBe('internal_error');
    expect(failed.message).toMatch(/boom/);
  });
});

describe('schedule_delete', () => {
  it('deletes the task and reports it', async () => {
    const { call } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    expect(await call('schedule_delete', { id: created.id })).toEqual({ id: created.id, deleted: true });
    expect((await call('schedule_get', { id: created.id })).code).toBe('not_found');
    expect((await call('schedule_delete', { id: created.id })).code).toBe('not_found');
  });
});

describe('project scoping', () => {
  it('treats another project\'s task as not_found for every operation', async () => {
    const { call, runNow } = setup();
    const other = await call('schedule_create', {
      title: 'foreign',
      prompt: 'p',
      project_path: OTHER,
      every_seconds: 60,
    });

    const calls = [
      ['schedule_get', { id: other.id }],
      ['schedule_update', { id: other.id, title: 'x' }],
      ['schedule_delete', { id: other.id }],
      ['schedule_run', { id: other.id }],
      ['schedule_pause', { id: other.id }],
      ['schedule_resume', { id: other.id }],
    ];
    for (const [name, args] of calls) {
      expect((await call(name, args)).code, name).toBe('not_found');
    }
    expect(runNow).not.toHaveBeenCalled();
  });

  it('treats an equivalent path as in scope', async () => {
    const { call, repo } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });
    // Same path with a redundant separator resolves to the same project.
    repo._tasks.get(created.id).project_path = PROJECT + '/';
    expect((await call('schedule_get', { id: created.id })).task.id).toBe(created.id);
  });
});

describe('handler safety', () => {
  it('never throws, even with garbage arguments', async () => {
    const { tools } = setup();
    for (const definition of tools) {
      for (const args of [undefined, {}, { id: 42 }, { id: 'x', title: {}, every_seconds: 'nope', include_paused: 'yes' }]) {
        const result = await definition.handler(args);
        expect(Array.isArray(result.content)).toBe(true);
        expect(() => JSON.parse(result.content[0].text)).not.toThrow();
      }
    }
  });

  it('reports repository failures as internal_error instead of throwing', async () => {
    const { call, repo } = setup();
    repo.listTasks.mockImplementation(() => {
      throw new Error('db down');
    });

    const result = await call('schedule_list', {});
    expect(result.code).toBe('internal_error');
    expect(result.message).toMatch(/db down/);
  });

  it('reports create failures as internal_error instead of throwing', async () => {
    const { call, repo } = setup();
    repo.createTask.mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });
    expect(result.code).toBe('internal_error');
    expect(result.message).toMatch(/disk full/);
  });
});

describe('script gate fields (§7)', () => {
  it('creates a gated task with command and command_timeout_seconds', async () => {
    const { call, repo } = setup();

    const task = await call('schedule_create', {
      title: 'gated',
      prompt: 'fallback prompt',
      every_seconds: 60,
      command: 'node scripts/check.mjs',
      command_timeout_seconds: 120,
    });

    expect(task.command).toBe('node scripts/check.mjs');
    expect(task.commandTimeoutSeconds).toBe(120);
    expect(repo._tasks.get(task.id).command).toBe('node scripts/check.mjs');
    expect(repo._tasks.get(task.id).command_timeout_seconds).toBe(120);
  });

  it('defaults the gate fields to null', async () => {
    const { call } = setup();

    const task = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    expect(task.command).toBeNull();
    expect(task.commandTimeoutSeconds).toBeNull();
  });

  it('rejects invalid gate values on create', async () => {
    const { call } = setup();
    const base = { title: 'a', prompt: 'p', every_seconds: 60 };

    expect((await call('schedule_create', { ...base, command: 42 })).code).toBe('invalid_input');
    expect((await call('schedule_create', { ...base, command: '' })).code).toBe('invalid_input');
    expect((await call('schedule_create', { ...base, command_timeout_seconds: 0 })).code).toBe('invalid_input');
    expect((await call('schedule_create', { ...base, command_timeout_seconds: 3601 })).code).toBe('invalid_input');
    expect((await call('schedule_create', { ...base, command_timeout_seconds: 60.5 })).code).toBe('invalid_input');
    expect((await call('schedule_create', { ...base, command_timeout_seconds: '60' })).code).toBe('invalid_input');
  });

  it('updates the gate without touching the schedule', async () => {
    const { call } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    const updated = await call('schedule_update', {
      id: created.id,
      command: 'node gate.mjs',
      command_timeout_seconds: 30,
    });

    expect(updated.command).toBe('node gate.mjs');
    expect(updated.commandTimeoutSeconds).toBe(30);
    expect(updated.nextRunAt).toBe(created.nextRunAt);
  });

  it('clears the gate with explicit nulls', async () => {
    const { call } = setup();
    const created = await call('schedule_create', {
      title: 'a',
      prompt: 'p',
      every_seconds: 60,
      command: 'gate.sh',
      command_timeout_seconds: 30,
    });

    const cleared = await call('schedule_update', {
      id: created.id,
      command: null,
      command_timeout_seconds: null,
    });

    expect(cleared.command).toBeNull();
    expect(cleared.commandTimeoutSeconds).toBeNull();
  });

  it('rejects invalid gate values on update', async () => {
    const { call } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });

    expect((await call('schedule_update', { id: created.id, command: 42 })).code).toBe('invalid_input');
    expect((await call('schedule_update', { id: created.id, command_timeout_seconds: 0 })).code).toBe(
      'invalid_input'
    );
  });

  it('documents the envelope in the tool descriptions', async () => {
    const { byName } = setup();

    for (const name of ['schedule_create', 'schedule_update']) {
      const description = byName[name].description;
      expect(description).toMatch(/command/);
      expect(description).toMatch(/skip/);
      expect(description).toMatch(/prompt/);
    }
  });
});

describe('§6.1 built-in Cron precedence', () => {
  const PREFERENCE_MARKER = 'preferred scheduler for this app';

  function firstSentence(description) {
    const end = description.indexOf('. ');
    return end === -1 ? description : description.slice(0, end + 1);
  }

  it('states the precedence note in the first sentence of all twelve descriptions', () => {
    const { tools } = setup();

    expect(tools).toHaveLength(12);
    for (const definition of tools) {
      const sentence = firstSentence(definition.description);
      expect(sentence, definition.name).toContain(PREFERENCE_MARKER);
      expect(sentence, definition.name).toContain('CronCreate');
      expect(sentence, definition.name).toContain('CronList');
      expect(sentence, definition.name).toContain('CronDelete');
      expect(sentence, definition.name).toMatch(/do NOT use/);
      expect(sentence, definition.name).toContain('Codex');
      expect(sentence, definition.name).toMatch(/unless the user explicitly asks/i);
    }
  });

  it('documents where the data lives on schedule_create and schedule_list', () => {
    const { byName } = setup();

    for (const name of ['schedule_create', 'schedule_list']) {
      const description = byName[name].description;
      expect(description, name).toContain('scheduled_tasks');
      expect(description, name).toContain('scheduled_task_runs');
      expect(description, name).toMatch(/DATABASE_PATH|\.cloudcli\/auth\.db/);
      expect(description, name).toContain('.claude/scheduled_tasks.json');
    }
  });

  it('explains on schedule_create why the built-ins must not be used', () => {
    const { byName } = setup();
    const description = byName.schedule_create.description;

    expect(description).toMatch(/separate store/i);
    expect(description).toMatch(/not visible/i);
    expect(description).toMatch(/7 days|7-day/i);
  });

  it('keeps the per-tool semantics after the precedence note', () => {
    const { byName } = setup();

    expect(byName.schedule_list.description).toMatch(/List scheduled tasks/);
    expect(byName.schedule_get.description).toMatch(/five most recent runs/);
    expect(byName.schedule_delete.description).toMatch(/Delete a scheduled task/);
    expect(byName.schedule_run.description).toMatch(/manual trigger/);
    expect(byName.schedule_pause.description).toMatch(/stops being due/);
    expect(byName.schedule_resume.description).toMatch(/recompute its next run/);
  });
});

describe('preset tools (§10.6)', () => {
  const PRESETS = [
    { id: 'alpha-daily', source: 'builtin', name: 'Alpha daily', taskCount: 1 },
    { id: 'mine', source: 'custom', name: 'Mine', taskCount: 2 },
  ];

  function makePresetsService() {
    return {
      listPresets: vi.fn(async () => ({ ok: true, presets: PRESETS })),
      getPreset: vi.fn(),
      installPreset: vi.fn(async (id, options) => ({
        ok: true,
        preset: { id, enabled: options.enabled !== false },
        tasks: [{ id: 'task-installed', presetId: id }],
        created: ['task-installed'],
        updated: [],
        skipped: [],
      })),
      setPresetEnabled: vi.fn(async (id, enabled) => ({
        ok: true,
        preset: { id, enabled },
        tasks: [{ id: 'task-installed', enabled }],
      })),
      createCustomPreset: vi.fn(async (input) => ({
        ok: true,
        preset: { id: 'custom-1', name: input.name, taskIds: input.taskIds },
      })),
      updatePreset: vi.fn(),
      deletePreset: vi.fn(),
    };
  }

  it('lists presets and can hide the built-in catalog', async () => {
    const presets = makePresetsService();
    const { call } = setup({ presets });

    expect(await call('schedule_preset_list', {})).toEqual({ presets: PRESETS });
    expect(presets.listPresets).toHaveBeenCalledWith({ projectPath: PROJECT });

    const custom = await call('schedule_preset_list', { include_catalog: false });
    expect(custom.presets.map((preset) => preset.id)).toEqual(['mine']);
  });

  it('installs into the session project by default', async () => {
    const presets = makePresetsService();
    const { call } = setup({ presets });

    const result = await call('schedule_preset_install', { id: 'alpha-daily' });

    expect(presets.installPreset).toHaveBeenCalledWith('alpha-daily', {
      projectPath: PROJECT,
      enabled: undefined,
      userId: null,
    });
    expect(result).toMatchObject({ created: ['task-installed'], updated: [], skipped: [] });
  });

  it('forwards an explicit target project and enabled flag', async () => {
    const presets = makePresetsService();
    const { call } = setup({ presets });

    await call('schedule_preset_install', { id: 'mine', project_path: OTHER, enabled: false });

    expect(presets.installPreset).toHaveBeenCalledWith('mine', {
      projectPath: OTHER,
      enabled: false,
      userId: null,
    });
  });

  it('flips a whole preset', async () => {
    const presets = makePresetsService();
    const { call } = setup({ presets });

    const result = await call('schedule_preset_set_enabled', { id: 'alpha-daily', enabled: false });

    expect(presets.setPresetEnabled).toHaveBeenCalledWith('alpha-daily', false, { projectPath: PROJECT });
    expect(result).toMatchObject({ preset: { enabled: false }, tasks: [{ enabled: false }] });
  });

  it('creates a custom preset from the session project tasks by default', async () => {
    const presets = makePresetsService();
    const { call } = setup({ presets });

    const mine = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60 });
    await call('schedule_create', { title: 'foreign', prompt: 'p', project_path: OTHER, every_seconds: 60 });
    const paused = await call('schedule_create', { title: 'b', prompt: 'p', every_seconds: 60 });
    await call('schedule_pause', { id: paused.id });

    await call('schedule_preset_create', { name: 'My bundle' });

    const input = presets.createCustomPreset.mock.calls[0][0];
    expect(input).toMatchObject({ name: 'My bundle', projectPath: PROJECT });
    expect(input.taskIds.sort()).toEqual([mine.id, paused.id].sort());
  });

  it('passes explicit task_ids through and surfaces preset errors', async () => {
    const presets = makePresetsService();
    presets.createCustomPreset.mockResolvedValueOnce({ ok: false, code: 'no_tasks', message: 'none' });
    const { call } = setup({ presets });

    const failed = await call('schedule_preset_create', { name: 'x', task_ids: [] });

    expect(failed).toMatchObject({ code: 'no_tasks' });
    expect(presets.createCustomPreset).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'x', taskIds: [] })
    );
  });

  it('documents the workspace layout on schedule_create and schedule_preset_install', () => {
    const { byName } = setup();

    for (const name of ['schedule_create', 'schedule_preset_install']) {
      const description = byName[name].description;
      expect(description, name).toMatch(/state\//);
      expect(description, name).toMatch(/runs\/<runId>\//);
      expect(description, name).toContain('SCHEDULED_TASK_STATE_DIR');
      expect(description, name).toMatch(/wiped at the start of every run/);
      expect(description, name).toMatch(/Never write outside the task root/);
    }
  });
});


describe('params (§12)', () => {
  const DEFS = [
    { name: 'region', type: 'string', default: 'eu' },
    { name: 'threshold', type: 'number', default: 3 },
  ];

  it('creates a task with normalized parameter definitions', async () => {
    const { call, repo } = setup();

    const created = await call('schedule_create', {
      title: 'a',
      prompt: 'p',
      every_seconds: 60,
      params: DEFS,
    });

    expect(created.params).toEqual(DEFS);
    expect(repo._tasks.get(created.id).params_json).toBe(JSON.stringify(DEFS));
  });

  it('rejects an invalid parameter definition', async () => {
    const { call, repo } = setup();

    const result = await call('schedule_create', {
      title: 'a',
      prompt: 'p',
      every_seconds: 60,
      params: [{ name: '1bad' }],
    });

    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(repo.createTask).not.toHaveBeenCalled();
  });

  it('updates and clears parameter definitions', async () => {
    const { call } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60, params: DEFS });

    const updated = await call('schedule_update', { id: created.id, params: [{ name: 'x', type: 'boolean' }] });
    expect(updated.params).toEqual([{ name: 'x', type: 'boolean' }]);

    const cleared = await call('schedule_update', { id: created.id, params: null });
    expect(cleared.params).toEqual([]);
  });

  it('forwards per-run overrides to schedule_run and rejects unknown names', async () => {
    const { call, runNow } = setup();
    const created = await call('schedule_create', { title: 'a', prompt: 'p', every_seconds: 60, params: DEFS });

    await call('schedule_run', { id: created.id, params: { threshold: 7 } });
    expect(runNow).toHaveBeenCalledWith(created.id, { params: { threshold: 7 } });

    const bad = await call('schedule_run', { id: created.id, params: { nope: 1 } });
    expect(bad).toMatchObject({ code: 'invalid_input' });
    expect(runNow).toHaveBeenCalledTimes(1);
  });

  it('forwards install params to the preset service', async () => {
    const installPreset = vi.fn(async (id, options) => ({
      ok: true,
      preset: { id },
      tasks: [],
      created: [],
      updated: [],
      skipped: [],
    }));
    const { call } = setup({ presets: { installPreset } });

    await call('schedule_preset_install', { id: 'alpha-daily', params: { region: 'us' } });

    expect(installPreset).toHaveBeenCalledWith('alpha-daily', {
      projectPath: PROJECT,
      enabled: undefined,
      params: { region: 'us' },
      userId: null,
    });
  });

  it('documents the parameter environment on schedule_create and schedule_run', () => {
    const { byName } = setup();
    expect(byName.schedule_create.description).toContain('SCHEDULED_TASK_PARAM_');
    expect(byName.schedule_run.description).toMatch(/params/);
    expect(byName.schedule_update.description).toMatch(/parameter/i);
  });

  it('lists every §13 predefined variable and the id clarification on all twelve tools', () => {
    const { byName } = setup();

    expect(PREDEFINED_ENV_NAMES).toHaveLength(9);
    expect(Object.keys(byName)).toHaveLength(12);

    for (const name of Object.keys(byName)) {
      const description = byName[name].description;

      for (const entry of PREDEFINED_TASK_VARS) {
        // Name plus its one-line meaning, not just the bare variable.
        expect(description, name + ' ' + entry.envName).toContain(
          entry.envName + ' (' + entry.description + ')'
        );
      }
      // The user-declared parameter namespace is named as well.
      expect(description, name).toContain('SCHEDULED_TASK_PARAM_');
      expect(description, name).toContain('SCHEDULED_TASK_PARAMS');
      // Where they are readable, and the no-hardcode instruction.
      expect(description, name).toMatch(/script gate/i);
      expect(description, name).toMatch(/never hardcode/i);
      // §13: SCHEDULED_TASK_ID is a task id, not the chat session id, and the
      // session id lives on the run instead of in the environment.
      expect(description, name).toMatch(/NOT a chat session id/i);
      expect(description, name).toContain('sessionId');
      expect(description, name).toContain(SESSION_ID_NOTE);
    }

    // The shared note is rendered from params.js, not hand-written: dropping a
    // variable from PREDEFINED_TASK_VARS would remove it from every description.
    expect(byName.schedule_create.description).toContain(PREDEFINED_TASK_VARS[3].envName);
    expect(byName.schedule_list.description).toContain('SCHEDULED_TASK_RUN_DIR');
  });
});
