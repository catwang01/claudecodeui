import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pass-through SDK mock so we can invoke the tool handlers directly.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name, description, schema, handler, extras) => ({ name, description, schema, handler, extras }),
}));

import { createScheduleTools, SCHEDULE_TOOL_NAMES, isScheduleToolsEnabled } from './tools.js';
import * as rules from './rules.js';

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
    deps: { repo, runNow, rules, now: () => NOW, ...depsOverrides },
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
  it('registers the eight schedule_* tools in contract order', () => {
    const { tools } = setup();
    expect(tools.map((definition) => definition.name)).toEqual(SCHEDULE_TOOL_NAMES);
    expect(SCHEDULE_TOOL_NAMES).toHaveLength(8);
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
