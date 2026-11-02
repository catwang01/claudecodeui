import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';

import { createScheduledTasksRouter } from './scheduled-tasks.js';

const NEXT_MS = Date.parse('2026-06-01T00:00:00.000Z');
const NEXT_ISO = new Date(NEXT_MS).toISOString();

function makeRepo() {
  const tasks = new Map();
  const runs = new Map();
  let idSeq = 0;
  const stamp = () => new Date().toISOString();

  return {
    createTask(input) {
      const id = input.id || `task-${++idSeq}`;
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
    listTasks: vi.fn((opts = {}) => {
      let out = [...tasks.values()];
      if (opts.status === 'active') out = out.filter((task) => !!task.enabled);
      if (opts.status === 'paused') out = out.filter((task) => !task.enabled);
      if (opts.search) {
        const needle = String(opts.search).toLowerCase();
        out = out.filter(
          (task) =>
            task.title.toLowerCase().includes(needle) ||
            task.prompt.toLowerCase().includes(needle) ||
            task.project_path.toLowerCase().includes(needle)
        );
      }
      return out;
    }),
    updateTask(id, patch) {
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
        conflictPolicy: 'conflict_policy',
        tagsJson: 'tags_json',
        projectPathsJson: 'project_paths_json',
      };
      for (const [key, value] of Object.entries(patch)) {
        const column = columns[key] || key;
        row[column] = key === 'enabled' ? (value ? 1 : 0) : value;
      }
      row.updated_at = stamp();
      return row;
    },
    deleteTask: vi.fn((id) => tasks.delete(id)),
    listRuns: vi.fn((taskId, limit = 20, offset = 0) => (runs.get(taskId) || []).slice(offset, offset + limit)),
    countRuns: vi.fn((taskId) => (runs.get(taskId) || []).length),
    advanceTask(id, patch) {
      const row = tasks.get(id);
      if (!row) return undefined;
      if ('nextRunAt' in patch) row.next_run_at = patch.nextRunAt;
      if ('lastRunAt' in patch) row.last_run_at = patch.lastRunAt;
      if ('lastStatus' in patch) row.last_status = patch.lastStatus;
      if ('lastError' in patch) row.last_error = patch.lastError;
      if ('runCount' in patch) row.run_count = patch.runCount;
      row.updated_at = stamp();
      return row;
    },
    _tasks: tasks,
    _runs: runs,
    _seedRun(taskId, overrides = {}) {
      const row = {
        id: `run-${Math.random().toString(16).slice(2, 8)}`,
        task_id: taskId,
        status: 'success',
        trigger: 'schedule',
        scheduled_for: null,
        started_at: stamp(),
        finished_at: stamp(),
        session_id: 'sess-1',
        output: 'done',
        error: null,
        ...overrides,
      };
      const list = runs.get(taskId) || [];
      list.unshift(row);
      runs.set(taskId, list);
      return row;
    },
  };
}

function makePresetsService() {
  return {
    listPresets: vi.fn(async () => ({
      ok: true,
      presets: [{ id: 'alpha-daily', source: 'builtin', name: 'Alpha daily', enabled: false, taskCount: 1, tasks: [] }],
    })),
    getPreset: vi.fn(async (id) =>
      id === 'missing'
        ? { ok: false, code: 'not_found', message: 'Preset not found', httpStatus: 404 }
        : { ok: true, preset: { id, source: 'builtin', name: 'Alpha daily' } }
    ),
    installPreset: vi.fn(async (id, options) => ({
      ok: true,
      preset: { id, enabled: options.enabled !== false },
      tasks: [{ id: 'task-1' }],
      created: ['task-1'],
      updated: [],
      skipped: [],
    })),
    setPresetEnabled: vi.fn(async (id, enabled) => ({
      ok: true,
      preset: { id, enabled },
      tasks: [{ id: 'task-1', enabled }],
    })),
    createCustomPreset: vi.fn(async (input) =>
      input.name
        ? { ok: true, preset: { id: 'custom-1', name: input.name, source: 'custom' } }
        : { ok: false, code: 'invalid_input', message: 'name is required', httpStatus: 400 }
    ),
    updatePreset: vi.fn(async (id, patch) =>
      id === 'alpha-daily'
        ? { ok: false, code: 'builtin_preset', message: 'Built-in presets cannot be edited', httpStatus: 400 }
        : { ok: true, preset: { id, ...patch } }
    ),
    upgradePreset: vi.fn(async (id) => ({
      ok: true,
      preset: { id, source: 'builtin', name: 'Alpha daily' },
      tasks: [{ id: 'task-1' }],
      projects: [{ projectPath: '/tmp/x', created: [], updated: ['task-1'], skipped: [] }],
    })),
    deletePreset: vi.fn(async (id, options) => ({
      ok: true,
      id,
      deleted: true,
      source: 'custom',
      removedTasks: options.purge === false ? 0 : 1,
    })),
  };
}

function makeDeps(repo) {
  return {
    repo,
    presets: makePresetsService(),
    workspace: { ensureTaskWorkspace: vi.fn(() => null), removeTaskWorkspace: vi.fn(() => true) },
    validateRule: vi.fn((rule) => {
      if (!rule || typeof rule !== 'object') {
        return { ok: false, code: 'invalid_rule', message: 'rule is required' };
      }
      if (rule.kind === 'bogus') {
        return { ok: false, code: 'invalid_cron', message: 'bad cron expression' };
      }
      return { ok: true, rule };
    }),
    normalizeRule: vi.fn((rule) => ({ ...rule, normalized: true })),
    computeNextRun: vi.fn(() => NEXT_MS),
    runNow: vi.fn(async (taskId) => ({
      run: {
        id: 'run-1',
        task_id: taskId,
        status: 'running',
        trigger: 'manual',
        scheduled_for: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        session_id: null,
        output: null,
        error: null,
      },
    })),
  };
}

let server;
let base;
let repo;
let deps;

beforeEach(async () => {
  repo = makeRepo();
  deps = makeDeps(repo);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 7 };
    next();
  });
  app.use('/api/scheduled-tasks', createScheduledTasksRouter(deps));

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/scheduled-tasks`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
});

async function api(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

const validBody = {
  title: 'Nightly docs',
  prompt: 'update the docs',
  projectPath: '/tmp/scheduled-project',
  rule: { kind: 'interval', everySeconds: 60 },
};

describe('POST /api/scheduled-tasks', () => {
  it('round-trips the chosen provider and permits changing it through PATCH', async () => {
    const created = await api('POST', '/', { ...validBody, provider: 'copilot' });
    expect(created.status).toBe(201);
    expect(created.body.task.provider).toBe('copilot');

    const updated = await api('PATCH', '/' + created.body.task.id, { provider: 'codex' });
    expect(updated.status).toBe(200);
    expect(updated.body.task.provider).toBe('codex');

    const invalid = await api('PATCH', '/' + created.body.task.id, { provider: 'unknown' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_input');
  });

  it('creates a task and returns 201 with camelCase task JSON', async () => {
    const { status, body } = await api('POST', '/', validBody);

    expect(status).toBe(201);
    expect(body.task).toMatchObject({
      id: expect.any(String),
      title: 'Nightly docs',
      prompt: 'update the docs',
      projectPath: '/tmp/scheduled-project',
      provider: 'claude',
      model: null,
      kind: 'interval',
      nextRunAt: NEXT_ISO,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      enabled: true,
      runCount: 0,
    });
    expect(body.task.rule).toMatchObject({ kind: 'interval', everySeconds: 60, normalized: true });
    // Interval rules are anchored at save time (docs §1).
    expect(typeof body.task.rule.anchorMs).toBe('number');
    expect(body.task.createdAt).toEqual(expect.any(String));

    // Stored row keeps snake_case and the user id.
    const row = repo._tasks.get(body.task.id);
    expect(row.user_id).toBe(7);
    expect(JSON.parse(row.rule_json)).toMatchObject({
      kind: 'interval',
      everySeconds: 60,
      normalized: true,
      anchorMs: body.task.rule.anchorMs,
    });
  });

  it('rejects missing required fields', async () => {
    const { status, body } = await api('POST', '/', { prompt: 'x' });

    expect(status).toBe(400);
    expect(body.code).toBe('invalid_input');
    expect(body.error).toMatch(/title/);
    expect(body.error).toMatch(/projectPath/);
    expect(repo.createTask).toBeUndefined; // guard: repo untouched
    expect(repo._tasks.size).toBe(0);
  });

  it('rejects an invalid rule with the rules-engine code', async () => {
    const { status, body } = await api('POST', '/', { ...validBody, rule: { kind: 'bogus' } });

    expect(status).toBe(400);
    expect(body.code).toBe('invalid_cron');
    expect(body.error).toBe('bad cron expression');
  });

  it('rejects a rule with no upcoming run', async () => {
    deps.computeNextRun.mockReturnValue(null);

    const { status, body } = await api('POST', '/', validBody);

    expect(status).toBe(400);
    expect(body.code).toBe('invalid_schedule_time');
  });
});

describe('GET /api/scheduled-tasks', () => {
  it('lists tasks and forwards status/search filters', async () => {
    await api('POST', '/', validBody);
    await api('POST', '/', { ...validBody, title: 'Other', prompt: 'other prompt' });

    const all = await api('GET', '/');
    expect(all.status).toBe(200);
    expect(all.body.tasks).toHaveLength(2);
    expect(repo.listTasks).toHaveBeenCalledWith({ userId: 7, status: undefined, search: undefined });

    const filtered = await api('GET', '/?status=paused&search=nightly');
    expect(filtered.status).toBe(200);
    expect(repo.listTasks).toHaveBeenCalledWith({ userId: 7, status: 'paused', search: 'nightly' });
  });

  it('returns a single task or 404', async () => {
    const created = await api('POST', '/', validBody);

    const found = await api('GET', `/${created.body.task.id}`);
    expect(found.status).toBe(200);
    expect(found.body.task.id).toBe(created.body.task.id);

    const missing = await api('GET', '/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Scheduled task not found', code: 'not_found' });
  });
});

describe('PATCH /api/scheduled-tasks/:id', () => {
  it('updates simple fields', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;

    const { status, body } = await api('PATCH', `/${id}`, { title: 'Renamed', model: 'claude-sonnet-4.6' });

    expect(status).toBe(200);
    expect(body.task.title).toBe('Renamed');
    expect(body.task.model).toBe('claude-sonnet-4.6');
  });

  it('clears nextRunAt when the task is paused', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;

    const { status, body } = await api('PATCH', `/${id}`, { enabled: false });

    expect(status).toBe(200);
    expect(body.task.enabled).toBe(false);
    expect(body.task.nextRunAt).toBeNull();
    expect(repo._tasks.get(id).next_run_at).toBeNull();
  });

  it('recomputes nextRunAt from now when a paused task is resumed', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;
    await api('PATCH', `/${id}`, { enabled: false });
    deps.computeNextRun.mockClear();

    const { status, body } = await api('PATCH', `/${id}`, { enabled: true });

    expect(status).toBe(200);
    expect(body.task.enabled).toBe(true);
    expect(deps.computeNextRun).toHaveBeenCalledTimes(1);
    expect(body.task.nextRunAt).toBe(NEXT_ISO);
  });

  it('recomputes nextRunAt and kind when the rule changes', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;
    deps.computeNextRun.mockReturnValue(NEXT_MS + 1000);

    const { status, body } = await api('PATCH', `/${id}`, {
      rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    });

    expect(status).toBe(200);
    expect(body.task.kind).toBe('daily');
    expect(body.task.rule).toMatchObject({ kind: 'daily', time: '09:00', timeZone: 'UTC', normalized: true });
    expect(body.task.nextRunAt).toBe(new Date(NEXT_MS + 1000).toISOString());
  });

  it('keeps a paused task paused when the rule changes', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;
    await api('PATCH', `/${id}`, { enabled: false });

    const { body } = await api('PATCH', `/${id}`, {
      rule: { kind: 'interval', everySeconds: 120 },
      enabled: false,
    });

    expect(body.task.enabled).toBe(false);
    expect(body.task.nextRunAt).toBeNull();
  });

  it('validates input and missing tasks', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;

    expect((await api('PATCH', `/${id}`, { enabled: 'yes' })).body.code).toBe('invalid_input');
    expect((await api('PATCH', `/${id}`, { rule: { kind: 'bogus' } })).body.code).toBe('invalid_cron');
    expect((await api('PATCH', '/missing', { title: 'x' })).status).toBe(404);
  });
});

describe('DELETE /api/scheduled-tasks/:id', () => {
  it('deletes a task and reports it', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;

    const { status, body } = await api('DELETE', `/${id}`);

    expect(status).toBe(200);
    expect(body).toEqual({ id, deleted: true });
    expect((await api('GET', `/${id}`)).status).toBe(404);
  });

  it('returns 404 for an unknown task', async () => {
    const { status, body } = await api('DELETE', '/missing');
    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
  });
});

describe('POST /api/scheduled-tasks/:id/run', () => {
  it('returns 202 with the running run row', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;

    const { status, body } = await api('POST', `/${id}/run`);

    expect(status).toBe(202);
    expect(deps.runNow).toHaveBeenCalledWith(id);
    expect(body.run).toMatchObject({ id: 'run-1', taskId: id, status: 'running', trigger: 'manual' });
  });

  it('returns 404 when the task does not exist', async () => {
    deps.runNow.mockResolvedValue({ error: 'not_found' });

    const { status, body } = await api('POST', '/missing/run');

    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
  });
});

describe('GET /api/scheduled-tasks/:id/runs', () => {
  it('lists runs with total', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;
    repo._seedRun(id, { output: 'first' });
    repo._seedRun(id, { output: 'second' });

    const { status, body } = await api('GET', `/${id}/runs?limit=1&offset=0`);

    expect(status).toBe(200);
    expect(repo.listRuns).toHaveBeenCalledWith(id, 1, 0);
    expect(body.total).toBe(2);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      taskId: id,
      status: 'success',
      trigger: 'schedule',
      sessionId: 'sess-1',
      output: 'second',
      finishedAt: expect.any(String),
    });
  });

  it('returns 404 for an unknown or deleted task', async () => {
    const { status, body } = await api('GET', '/gone/runs');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Scheduled task not found', code: 'not_found' });
  });
});

describe('error handling', () => {
  it('returns a generic 500 without leaking the stack trace', async () => {
    repo.listTasks.mockImplementation(() => {
      throw new Error('kaboom-secret');
    });

    const { status, body } = await api('GET', '/');

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error', code: 'internal_error' });
    expect(JSON.stringify(body)).not.toContain('kaboom-secret');
    expect(JSON.stringify(body)).not.toContain('at ');
  });
});

describe('script gate fields (§7)', () => {
  it('accepts command and commandTimeoutSeconds on create', async () => {
    const { status, body } = await api('POST', '/', {
      ...validBody,
      command: 'echo hi',
      commandTimeoutSeconds: 120,
    });

    expect(status).toBe(201);
    expect(body.task.command).toBe('echo hi');
    expect(body.task.commandTimeoutSeconds).toBe(120);

    const row = repo._tasks.get(body.task.id);
    expect(row.command).toBe('echo hi');
    expect(row.command_timeout_seconds).toBe(120);
  });

  it('defaults both gate fields to null', async () => {
    const { body } = await api('POST', '/', validBody);

    expect(body.task.command).toBeNull();
    expect(body.task.commandTimeoutSeconds).toBeNull();
  });

  it('rejects invalid command and timeout values on create', async () => {
    expect((await api('POST', '/', { ...validBody, command: 42 })).body.code).toBe('invalid_input');
    expect((await api('POST', '/', { ...validBody, command: '' })).body.code).toBe('invalid_input');
    expect((await api('POST', '/', { ...validBody, commandTimeoutSeconds: 0 })).body.code).toBe('invalid_input');
    expect((await api('POST', '/', { ...validBody, commandTimeoutSeconds: 3601 })).body.code).toBe('invalid_input');
    expect((await api('POST', '/', { ...validBody, commandTimeoutSeconds: 60.5 })).body.code).toBe('invalid_input');
    expect((await api('POST', '/', { ...validBody, commandTimeoutSeconds: '60' })).body.code).toBe('invalid_input');
  });

  it('updates and explicitly clears both fields with null', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;

    const set = await api('PATCH', '/' + id, { command: 'echo gate', commandTimeoutSeconds: 30 });
    expect(set.status).toBe(200);
    expect(set.body.task.command).toBe('echo gate');
    expect(set.body.task.commandTimeoutSeconds).toBe(30);

    const cleared = await api('PATCH', '/' + id, { command: null, commandTimeoutSeconds: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.command).toBeNull();
    expect(cleared.body.task.commandTimeoutSeconds).toBeNull();
    expect(repo._tasks.get(id).command).toBeNull();
    expect(repo._tasks.get(id).command_timeout_seconds).toBeNull();
  });

  it('rejects invalid gate values on PATCH', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;

    expect((await api('PATCH', '/' + id, { command: 42 })).body.code).toBe('invalid_input');
    expect((await api('PATCH', '/' + id, { commandTimeoutSeconds: 0 })).body.code).toBe('invalid_input');
    expect((await api('PATCH', '/' + id, { commandTimeoutSeconds: 3601 })).body.code).toBe('invalid_input');
  });

  it('exposes the script gate fields on runs, including skipped', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;
    repo._seedRun(id, {
      status: 'skipped',
      output: 'nothing to do',
      script_exit_code: 0,
      script_output: '{"skip":true}',
      prompt_used: null,
    });

    const { body } = await api('GET', '/' + id + '/runs');

    expect(body.runs[0]).toMatchObject({
      status: 'skipped',
      output: 'nothing to do',
      scriptExitCode: 0,
      scriptOutput: '{"skip":true}',
      promptUsed: null,
    });
  });
});

describe('presets REST (§10.5)', () => {
  it('serves GET /presets instead of letting GET /:id capture it', async () => {
    const { status, body } = await api('GET', '/presets?projectPath=/tmp/x');

    expect(status).toBe(200);
    expect(body.presets).toHaveLength(1);
    expect(deps.presets.listPresets).toHaveBeenCalledWith({ projectPath: '/tmp/x' });
    expect(repo.getTask).not.toHaveBeenCalled();
  });

  it('POST /presets creates a custom preset with 201', async () => {
    const { status, body } = await api('POST', '/presets', {
      name: 'Mine',
      projectPath: '/tmp/x',
      taskIds: ['t1'],
    });

    expect(status).toBe(201);
    expect(body.preset).toMatchObject({ id: 'custom-1', name: 'Mine' });
    expect(deps.presets.createCustomPreset).toHaveBeenCalledWith({
      name: 'Mine',
      description: undefined,
      projectPath: '/tmp/x',
      taskIds: ['t1'],
      userId: 7,
    });
  });

  it('GET /presets/:id returns the preset or 404', async () => {
    const found = await api('GET', '/presets/alpha-daily');
    expect(found.status).toBe(200);
    expect(found.body.preset.id).toBe('alpha-daily');

    const missing = await api('GET', '/presets/missing');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
  });

  it('PATCH /presets/:id surfaces builtin_preset as 400', async () => {
    const { status, body } = await api('PATCH', '/presets/alpha-daily', { name: 'x' });
    expect(status).toBe(400);
    expect(body.code).toBe('builtin_preset');
  });

  it('POST /presets/:id/install returns the materialized bundle', async () => {
    const { status, body } = await api('POST', '/presets/alpha-daily/install', { projectPath: '/tmp/x' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ created: ['task-1'], updated: [], skipped: [] });
    expect(deps.presets.installPreset).toHaveBeenCalledWith('alpha-daily', {
      projectPath: '/tmp/x',
      enabled: undefined,
      userId: 7,
    });
  });

  it('POST /presets/:id/enable and /disable flip the whole bundle', async () => {
    const on = await api('POST', '/presets/alpha-daily/enable', { projectPath: '/tmp/x' });
    expect(on.status).toBe(200);
    expect(on.body.preset.enabled).toBe(true);

    const off = await api('POST', '/presets/alpha-daily/disable', {});
    expect(off.status).toBe(200);
    expect(off.body.preset.enabled).toBe(false);
    expect(deps.presets.setPresetEnabled).toHaveBeenCalledWith('alpha-daily', false, {
      projectPath: undefined,
    });
  });

  it('DELETE /presets/:id purges by default and honours ?purge=0', async () => {
    const purged = await api('DELETE', '/presets/custom-1');
    expect(purged.status).toBe(200);
    expect(purged.body).toEqual({ id: 'custom-1', deleted: true, removedTasks: 1 });
    expect(deps.presets.deletePreset).toHaveBeenCalledWith('custom-1', { purge: true }, {
      projectPath: undefined,
    });

    const kept = await api('DELETE', '/presets/custom-1?purge=0');
    expect(kept.body.removedTasks).toBe(0);
    expect(deps.presets.deletePreset).toHaveBeenLastCalledWith('custom-1', { purge: false }, {
      projectPath: undefined,
    });
  });
});

describe('DELETE /:id?purge=1 (§10.4)', () => {
  it('purges the task workspace only when asked', async () => {
    const first = await api('POST', '/', validBody);
    const plain = await api('DELETE', `/${first.body.task.id}`);
    expect(plain.status).toBe(200);
    expect(plain.body).toEqual({ id: first.body.task.id, deleted: true });
    expect(deps.workspace.removeTaskWorkspace).not.toHaveBeenCalled();

    const second = await api('POST', '/', validBody);
    const purged = await api('DELETE', `/${second.body.task.id}?purge=1`);
    expect(purged.status).toBe(200);
    expect(deps.workspace.removeTaskWorkspace).toHaveBeenCalledWith(second.body.task.id);
  });
});


describe('params (§12)', () => {
  const DEFS = [
    { name: 'region', type: 'string', default: 'eu' },
    { name: 'threshold', type: 'number', default: 3 },
  ];

  it('round-trips params on create and rejects invalid definitions', async () => {
    const created = await api('POST', '/', { ...validBody, params: DEFS });

    expect(created.status).toBe(201);
    expect(created.body.task.params).toEqual(DEFS);
    expect(repo._tasks.get(created.body.task.id).params_json).toBe(JSON.stringify(DEFS));

    const bad = await api('POST', '/', { ...validBody, params: [{ name: '1bad' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_input');
  });

  it('updates and clears params through PATCH', async () => {
    const created = await api('POST', '/', { ...validBody, params: DEFS });

    const patched = await api('PATCH', `/${created.body.task.id}`, {
      params: [{ name: 'x', type: 'boolean' }],
    });
    expect(patched.body.task.params).toEqual([{ name: 'x', type: 'boolean' }]);

    const cleared = await api('PATCH', `/${created.body.task.id}`, { params: null });
    expect(cleared.body.task.params).toEqual([]);
  });

  it('forwards per-run overrides on POST /:id/run', async () => {
    const created = await api('POST', '/', { ...validBody, params: DEFS });

    const ran = await api('POST', `/${created.body.task.id}/run`, { params: { threshold: 7 } });

    expect(ran.status).toBe(202);
    expect(deps.runNow).toHaveBeenCalledWith(created.body.task.id, { params: { threshold: 7 } });
  });

  it('rejects an unknown override before starting a run', async () => {
    const created = await api('POST', '/', { ...validBody, params: DEFS });

    const ran = await api('POST', `/${created.body.task.id}/run`, { params: { nope: 1 } });

    expect(ran.status).toBe(400);
    expect(ran.body.code).toBe('invalid_input');
    expect(deps.runNow).not.toHaveBeenCalled();
  });

  it('forwards params on preset install', async () => {
    const result = await api('POST', '/presets/alpha-daily/install', {
      projectPath: '/tmp/x',
      params: { region: 'us' },
    });

    expect(result.status).toBe(200);
    expect(deps.presets.installPreset).toHaveBeenCalledWith('alpha-daily', {
      projectPath: '/tmp/x',
      enabled: undefined,
      params: { region: 'us' },
      userId: 7,
    });
  });
});

describe('GET /running (§14.3)', () => {
  it('returns the number of tasks whose agent has started', async () => {
    repo.countRunningAgentRuns = vi.fn(() => 4);

    const result = await api('GET', '/running');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ count: 4, runs: [] });
    expect(repo.countRunningAgentRuns).toHaveBeenCalledTimes(1);
  });

  it('reads as 0 and never shadows GET /:id', async () => {
    const before = await api('GET', '/running');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ count: 0, runs: [] });

    const created = await api('POST', '/', validBody);
    const fetched = await api('GET', '/' + created.body.task.id);
    expect(fetched.status).toBe(200);
    expect(fetched.body.task.id).toBe(created.body.task.id);
  });
});

describe('copy / import / export (§15, §16)', () => {
  it('POST /:id/copy duplicates a task paused with 201', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;

    const result = await api('POST', `/${id}/copy`, { title: 'Copy of docs' });

    expect(result.status).toBe(201);
    expect(result.body.task.id).not.toBe(id);
    expect(result.body.task).toMatchObject({
      title: 'Copy of docs',
      enabled: false,
      projectPath: validBody.projectPath,
    });
  });

  it('POST /:id/copy returns 404 for an unknown task', async () => {
    const result = await api('POST', '/missing/copy', {});
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('not_found');
  });

  it('GET /:id/export returns an envelope and POST /import recreates it paused', async () => {
    const created = await api('POST', '/', validBody);
    const id = created.body.task.id;

    const exported = await api('GET', `/${id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ format: 'claudecodeui.scheduled-task', version: 1 });
    expect(exported.body.task).toMatchObject({ title: validBody.title, prompt: validBody.prompt });
    expect(exported.body.task.id).toBeUndefined();

    const imported = await api('POST', '/import', { ...exported.body, projectPath: '/tmp/other' });
    expect(imported.status).toBe(201);
    expect(imported.body.task).toMatchObject({ projectPath: '/tmp/other', enabled: false });
  });

  it('POST /import rejects a foreign format and never shadows GET /:id', async () => {
    const bad = await api('POST', '/import', { format: 'nope', task: validBody });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_input');

    const shadowed = await api('GET', '/import');
    expect(shadowed.status).toBe(404);
  });
});

describe('POST /presets/:id/upgrade (§16)', () => {
  it('returns the upgraded projects', async () => {
    const result = await api('POST', '/presets/alpha-daily/upgrade', {});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      preset: { id: 'alpha-daily' },
      projects: [{ projectPath: '/tmp/x', updated: ['task-1'], created: [], skipped: [] }],
    });
  });
});
describe('conflict policy (§17)', () => {
  it('round-trips conflictPolicy on create and PATCH', async () => {
    const created = await api('POST', '/', { ...validBody, conflictPolicy: 'queue' });
    expect(created.body.task.conflictPolicy).toBe('queue');

    const patched = await api('PATCH', '/' + created.body.task.id, { conflictPolicy: 'replace' });
    expect(patched.body.task.conflictPolicy).toBe('replace');

    const bad = await api('POST', '/', { ...validBody, conflictPolicy: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_input');
  });

  it('returns 202 { queued: true } when the queue policy defers a manual run', async () => {
    deps.runNow.mockResolvedValueOnce({ queued: true });
    const created = await api('POST', '/', validBody);

    const result = await api('POST', '/' + created.body.task.id + '/run', {});

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ queued: true });
  });
});
describe('tags / preview / upcoming (§19–§21)', () => {
  it('round-trips tags and filters by tag', async () => {
    const created = await api('POST', '/', { ...validBody, tags: ['Ops', 'docs'] });
    expect(created.body.task.tags).toEqual(['Ops', 'docs']);

    const patched = await api('PATCH', '/' + created.body.task.id, { tags: ['docs'] });
    expect(patched.body.task.tags).toEqual(['docs']);

    const filtered = await api('GET', '/?tag=docs');
    expect(filtered.body.tasks).toHaveLength(1);
    const none = await api('GET', '/?tag=missing');
    expect(none.body.tasks).toHaveLength(0);
  });

  it('POST /:id/preview returns the gate decision', async () => {
    const created = await api('POST', '/', validBody);
    const result = await api('POST', '/' + created.body.task.id + '/preview', {});
    expect(result.status).toBe(200);
    expect(result.body.preview).toMatchObject({ decision: 'run' });
  });

  it('GET /upcoming is not shadowed by GET /:id', async () => {
    await api('POST', '/', validBody);
    const result = await api('GET', '/upcoming');
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.upcoming)).toBe(true);
  });
});



describe('multi-project binding (§22)', () => {
  it('round-trips projectPaths on create and patch', async () => {
    const created = await api('POST', '/', { ...validBody, projectPaths: ['/tmp/a', '/tmp/b'] });
    expect(created.status).toBe(201);
    expect(created.body.task.projectPaths).toEqual(['/tmp/a', '/tmp/b']);
    expect(created.body.task.projectPath).toBe('/tmp/a');

    const patched = await api('PATCH', '/' + created.body.task.id, { projectPaths: ['/tmp/c'] });
    expect(patched.status).toBe(200);
    expect(patched.body.task.projectPaths).toEqual(['/tmp/c']);
    expect(patched.body.task.projectPath).toBe('/tmp/c');
  });
});

describe('GET /running list (§22)', () => {
  it('returns the count plus the running runs', async () => {
    repo.countRunningAgentRuns = vi.fn(() => 1);
    repo.listRunningAgentRuns = vi.fn(() => [
      {
        id: 'run-1',
        task_id: 'task-x',
        status: 'running',
        trigger: 'schedule',
        scheduled_for: null,
        started_at: '2026-01-01T00:00:00.000Z',
        agent_started_at: '2026-01-01T00:00:00.000Z',
        session_id: 'sess-1',
        project_path: '/tmp/a',
        task_title: 'Task A',
        task_project_path: '/tmp/a',
        task_project_paths_json: JSON.stringify(['/tmp/a', '/tmp/b']),
      },
    ]);

    const result = await api('GET', '/running');

    expect(result.status).toBe(200);
    expect(result.body.count).toBe(1);
    expect(result.body.runs).toEqual([
      expect.objectContaining({
        id: 'run-1',
        taskId: 'task-x',
        taskTitle: 'Task A',
        projectPath: '/tmp/a',
        sessionId: 'sess-1',
      }),
    ]);
  });
});
