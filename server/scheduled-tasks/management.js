/**
 * Shared scheduled-task management layer.
 *
 * Single source of truth for task/run views, selector→rule mapping and the
 * create/update/pause/resume/delete/run-now orchestration. Both the REST routes
 * (server/routes/scheduled-tasks.js) and the agent tools
 * (server/scheduled-tasks/tools.js) delegate here so the two paths cannot drift.
 *
 * Contract: docs/scheduled-tasks.md §1, §5, §6.
 *
 * Every public operation returns one of:
 *   { ok: true, ...payload }
 *   { ok: false, code, message, httpStatus }   // expected failure
 * Unexpected errors (e.g. a broken repository) propagate to the caller, which
 * maps them to 500 / internal_error.
 */

import { normalizeProjectPath } from '../shared/utils.js';
// §12: the pure parameter layer owns the model, coercion and resolution.
import { normalizeParamDefs, parseParamDefs, resolveParams } from './params.js';

const TASK_STATUSES = new Set(['active', 'paused', 'all']);
const DEFAULT_RUNS_LIMIT = 20;
const MAX_RUNS_LIMIT = 100;

/** §16: portable single-task export envelope (format id + schema version). */
export const TASK_EXPORT_FORMAT = 'claudecodeui.scheduled-task';
export const TASK_EXPORT_VERSION = 1;

function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

function fail(code, message, httpStatus = 400) {
  return { ok: false, code, message, httpStatus };
}

function notFound(message = 'Scheduled task not found') {
  return { ok: false, code: 'not_found', message, httpStatus: 404 };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const MAX_COMMAND_TIMEOUT_SECONDS = 3600;

/** §7: command is an optional shell string; explicit null clears it. */
function checkCommand(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || !value.trim()) {
    return fail('invalid_input', 'command must be a non-empty string or null');
  }
  return { ok: true, value };
}

/** §7: commandTimeoutSeconds is an optional int in 1..3600; null clears it. */
function checkCommandTimeout(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_COMMAND_TIMEOUT_SECONDS) {
    return fail(
      'invalid_input',
      `commandTimeoutSeconds must be an integer between 1 and ${MAX_COMMAND_TIMEOUT_SECONDS}, or null`
    );
  }
  return { ok: true, value };
}

function hasValue(value) {
  return value !== undefined && value !== null;
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function parseJson(raw, fallback = null) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** §12.4: resolved value map of a run; NULL/'' or unreadable JSON reads as null. */
function parseParamValues(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const parsed = parseJson(raw, null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/**
 * §12.1/§12.3: normalize a params input.
 *   undefined => not supplied (leave the column alone)
 *   null      => clear (params_json NULL)
 *   array     => normalized ParamDef[] serialized for params_json
 */
function checkParams(value) {
  if (value === null) return { ok: true, value: null };
  const checked = normalizeParamDefs(value);
  if (!checked.ok) return fail(checked.code, checked.message);
  return { ok: true, value: JSON.stringify(checked.params) };
}

/** DB row (snake_case) -> Task JSON (camelCase). */
export function taskRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    projectPath: row.project_path ?? row.projectPath ?? null,
    presetId: row.preset_id ?? row.presetId ?? null,
    presetTaskId: row.preset_task_id ?? row.presetTaskId ?? null,
    provider: row.provider ?? 'claude',
    model: row.model ?? null,
    command: row.command ?? null,
    commandTimeoutSeconds: row.command_timeout_seconds ?? null,
    // §12.4: NULL/'' or legacy JSON reads as [].
    params: parseParamDefs(row.params_json ?? row.paramsJson),
    kind: row.kind,
    rule: parseJson(row.rule_json ?? row.ruleJson),
    nextRunAt: row.next_run_at ?? null,
    lastRunAt: row.last_run_at ?? null,
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
    enabled: row.enabled === undefined ? false : !!row.enabled,
    runCount: row.run_count ?? 0,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** DB row (snake_case) -> Run JSON (camelCase). */
export function runRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id ?? row.taskId ?? null,
    status: row.status,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    sessionId: row.session_id ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    scriptExitCode: row.script_exit_code ?? null,
    scriptOutput: row.script_output ?? null,
    promptUsed: row.prompt_used ?? null,
    // §14.3: when the runner actually started the agent. NULL while the run is
    // still in the script gate, so the UI can tell the two phases apart.
    agentStartedAt: row.agent_started_at ?? row.agentStartedAt ?? null,
    // §12.6: the resolved parameter values of this run.
    params: parseParamValues(row.params_json ?? row.paramsJson),
  };
}

function normalizePath(value) {
  if (!value) return value;
  try {
    return normalizeProjectPath(value);
  } catch {
    return value;
  }
}

export function sameProjectPath(a, b) {
  if (!a || !b) return false;
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/**
 * Selector args -> rule. Exactly one selector is required when required=true.
 * @returns {{ ok: true, rule: object|null } | { ok: false, code, message, httpStatus }}
 */
export function ruleFromArgs(args, nowMs, { required = true } = {}) {
  const source = args || {};
  const present = [];
  if (hasValue(source.after_seconds)) present.push('after_seconds');
  if (hasValue(source.at)) present.push('at');
  if (hasValue(source.every_seconds)) present.push('every_seconds');
  if (hasValue(source.daily)) present.push('daily');
  if (hasValue(source.weekly)) present.push('weekly');
  if (hasValue(source.cron)) present.push('cron');

  if (present.length === 0) {
    if (!required) return { ok: true, rule: null };
    return fail(
      'invalid_input',
      'Exactly one scheduling selector is required (after_seconds, at, every_seconds, daily, weekly or cron)'
    );
  }
  if (present.length > 1) {
    return fail('invalid_input', 'Provide exactly one selector, got: ' + present.join(', '));
  }

  const key = present[0];
  if (key === 'after_seconds') {
    const seconds = Number(source.after_seconds);
    if (!Number.isFinite(seconds)) {
      return fail('invalid_input', 'after_seconds must be a number');
    }
    return { ok: true, rule: { kind: 'once', at: new Date(nowMs + seconds * 1000).toISOString() } };
  }
  if (key === 'at') {
    return { ok: true, rule: { kind: 'once', at: String(source.at) } };
  }
  if (key === 'every_seconds') {
    return {
      ok: true,
      rule: { kind: 'interval', everySeconds: source.every_seconds, anchorMs: nowMs },
    };
  }
  if (key === 'daily') {
    return {
      ok: true,
      rule: { kind: 'daily', time: source.daily?.time, timeZone: source.daily?.time_zone },
    };
  }
  if (key === 'weekly') {
    return {
      ok: true,
      rule: {
        kind: 'weekly',
        time: source.weekly?.time,
        timeZone: source.weekly?.time_zone,
        weekdays: source.weekly?.weekdays,
      },
    };
  }
  return {
    ok: true,
    rule: {
      kind: 'cron',
      expression: source.cron?.expression,
      timeZone: source.cron?.time_zone,
    },
  };
}

// ─── Lazy defaults (tests inject fakes) ───────────────────────────────────────

async function loadDefaultRepo() {
  const db = await import('../modules/database/index.js');
  return db.scheduledTasksDb;
}

let cachedRules = null;
async function loadDefaultRules() {
  if (!cachedRules) cachedRules = await import('./rules.js');
  return cachedRules;
}

let cachedRunNow = null;
async function loadDefaultRunNow() {
  if (!cachedRunNow) {
    const service = await import('./service.js');
    cachedRunNow = service.runScheduledTaskNow;
  }
  return cachedRunNow;
}

// §10.3 preset service. Loaded lazily so a missing/incomplete presets module
// (or a repo without the preset tables) never breaks task management.
let cachedPresetsModule = null;
async function loadPresetsModule() {
  if (!cachedPresetsModule) cachedPresetsModule = await import('./presets.js');
  return cachedPresetsModule;
}

// §10.4 workspace module. Optional everywhere: filesystem failures and a
// missing module are logged, never thrown (a task must still run).
let cachedWorkspaceModule;
let workspaceModuleLoaded = false;
async function loadDefaultWorkspace() {
  if (!workspaceModuleLoaded) {
    workspaceModuleLoaded = true;
    try {
      cachedWorkspaceModule = await import('./workspace.js');
    } catch {
      cachedWorkspaceModule = null;
    }
  }
  return cachedWorkspaceModule;
}

/**
 * @param {object} [deps]
 * @param {object} [deps.repo] scheduledTasksDb-compatible repository
 * @param {object} [deps.rules] { validateRule, normalizeRule, computeNextRun }
 * @param {Function} [deps.runNow] (taskId) => { run } | { error }
 * @param {Function} [deps.now] () => epoch ms
 * @param {object|null} [deps.workspace] §10.4 workspace module (undefined = load lazily, null/false = disabled)
 * @param {object} [deps.presets] §10.3 preset service (tests; default is built lazily)
 * @param {Array} [deps.catalog] preset catalog for the default preset service (tests)
 */
export function createManagement(deps = {}) {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  let repoRef = deps.repo ?? null;
  let rulesRef = deps.rules ?? null;
  let runNowRef = deps.runNow ?? null;
  let presetsRef = deps.presets ?? null;
  // undefined => load ./workspace.js lazily; null/false => workspace disabled.
  const workspaceDep = deps.workspace;

  async function getRepo() {
    if (!repoRef) repoRef = await loadDefaultRepo();
    return repoRef;
  }

  async function getRules() {
    if (!rulesRef) rulesRef = await loadDefaultRules();
    return rulesRef;
  }

  async function getRunNow() {
    if (!runNowRef) runNowRef = await loadDefaultRunNow();
    return runNowRef;
  }

  async function getWorkspace() {
    if (workspaceDep !== undefined) return workspaceDep;
    return loadDefaultWorkspace();
  }

  async function getPresetsService() {
    if (presetsRef) return presetsRef;
    const [repo, rules, presetsModule] = await Promise.all([getRepo(), getRules(), loadPresetsModule()]);
    presetsRef =
      deps.presets ??
      presetsModule.createPresetService({
        repo,
        rules,
        workspace: workspaceDep,
        catalog: deps.catalog,
        logger,
        now,
      });
    return presetsRef;
  }

  // §10.4: the task's on-disk layout exists right after create/update; a
  // filesystem failure must never fail the request.
  async function ensureTaskWorkspaceBestEffort(row) {
    if (!row) return;
    const workspace = await getWorkspace();
    if (!workspace || typeof workspace.ensureTaskWorkspace !== 'function') return;
    try {
      const result = workspace.ensureTaskWorkspace(row);
      if (result && typeof result.then === 'function') await result;
    } catch (err) {
      logger.warn?.(`[scheduled-tasks] workspace setup failed for ${row.id}: ${errorMessage(err)}`);
    }
  }

  // §10.4: DELETE ?purge=1 removes <root>/<taskId>. Best-effort.
  async function purgeTaskWorkspace(taskId) {
    const workspace = await getWorkspace();
    if (!workspace) return false;
    try {
      if (typeof workspace.removeTaskWorkspace === 'function') {
        const result = await workspace.removeTaskWorkspace(taskId);
        return result !== false;
      }
      if (typeof workspace.taskDir !== 'function') return false;
      const dir = workspace.taskDir(taskId);
      if (!dir) return false;
      const fs = await import('node:fs');
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      logger.warn?.(`[scheduled-tasks] workspace purge failed for ${taskId}: ${errorMessage(err)}`);
      return false;
    }
  }

  function validateAndNormalize(rule, rules) {
    const check = rules.validateRule(rule);
    if (!check || !check.ok) {
      return fail(
        (check && check.code) || 'invalid_rule',
        (check && check.message) || 'Invalid rule'
      );
    }
    try {
      return { ok: true, rule: rules.normalizeRule(rule) };
    } catch (err) {
      return fail((err && err.code) || 'invalid_rule', (err && err.message) || 'Invalid rule');
    }
  }

  /**
   * Interval rules are anchored at creation/save time (docs §1). normalizeRule
   * keeps an explicit anchor but does not create one, so default it here.
   */
  function withIntervalAnchor(rule, fromMs) {
    if (
      rule &&
      typeof rule === 'object' &&
      !Array.isArray(rule) &&
      rule.kind === 'interval' &&
      rule.anchorMs === undefined &&
      rule.anchorAt === undefined
    ) {
      return { ...rule, anchorMs: fromMs };
    }
    return rule;
  }

  function nextRunIso(rule, rules, fromMs) {
    if (!rule) return null;
    try {
      return toIso(rules.computeNextRun(rule, fromMs));
    } catch (err) {
      logger.warn?.('[scheduled-tasks] computeNextRun failed: ' + errorMessage(err));
      return null;
    }
  }

  function inScope(row, scope) {
    if (!scope || !scope.projectPath) return true;
    return sameProjectPath(row.project_path, scope.projectPath);
  }

  async function findTask(id, scope) {
    const repo = await getRepo();
    const row = repo.getTask(id);
    if (!row || !inScope(row, scope)) return null;
    return row;
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  async function listTasks(options = {}, scope = {}) {
    const repo = await getRepo();
    const status =
      typeof options.status === 'string' && TASK_STATUSES.has(options.status)
        ? options.status
        : undefined;
    const search = nonEmptyString(options.search) || undefined;
    let rows = repo.listTasks({ userId: options.userId ?? null, status, search }) || [];
    if (scope && scope.projectPath) {
      rows = rows.filter((row) => inScope(row, scope));
    }
    return { ok: true, tasks: rows.map(taskRowToJson) };
  }

  async function getTask(id, scope = {}) {
    const row = await findTask(id, scope);
    if (!row) return notFound();
    return { ok: true, task: taskRowToJson(row) };
  }

  async function listRuns(id, options = {}, scope = {}) {
    const repo = await getRepo();
    const row = await findTask(id, scope);
    if (!row) return notFound();
    const limit = clampInt(options.limit, DEFAULT_RUNS_LIMIT, 1, MAX_RUNS_LIMIT);
    const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const runs = repo.listRuns(id, limit, offset) || [];
    const total = typeof repo.countRuns === 'function' ? repo.countRuns(id) : runs.length;
    return { ok: true, runs: runs.map(runRowToJson), total };
  }

  /**
   * §14.3: how many scheduled tasks currently have an agent-started run in
   * flight. The script-gate phase and a run that will be skipped do not count.
   * A repository without the method (older fakes) reads as 0.
   */
  async function countRunningTasks() {
    const repo = await getRepo();
    const count =
      typeof repo.countRunningAgentRuns === 'function' ? repo.countRunningAgentRuns() : 0;
    return { ok: true, count: Number.isFinite(count) ? count : 0 };
  }

  async function getTaskWithRuns(id, scope = {}, limit = 5) {
    const row = await findTask(id, scope);
    if (!row) return notFound();
    const repo = await getRepo();
    const capped = clampInt(limit, 5, 1, MAX_RUNS_LIMIT);
    const runs = repo.listRuns(id, capped, 0) || [];
    return { ok: true, task: taskRowToJson(row), recent_runs: runs.map(runRowToJson) };
  }

  // ─── Mutations ──────────────────────────────────────────────────────────────

  async function createTask(input = {}, scope = {}) {
    const repo = await getRepo();
    const rules = await getRules();

    const title = nonEmptyString(input.title);
    const projectPath = nonEmptyString(input.projectPath) || nonEmptyString(scope.projectPath);
    const missing = [];
    if (!title) missing.push('title');
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) missing.push('prompt');
    if (!projectPath) missing.push('projectPath');
    if (missing.length) {
      return fail('invalid_input', 'Missing required field(s): ' + missing.join(', '));
    }

    const command = input.command === undefined ? undefined : checkCommand(input.command);
    if (command && !command.ok) return command;
    const commandTimeoutSeconds =
      input.commandTimeoutSeconds === undefined ? undefined : checkCommandTimeout(input.commandTimeoutSeconds);
    if (commandTimeoutSeconds && !commandTimeoutSeconds.ok) return commandTimeoutSeconds;

    const params = input.params === undefined ? undefined : checkParams(input.params);
    if (params && !params.ok) return params;

    const nowMs = now();
    const checked = validateAndNormalize(withIntervalAnchor(input.rule, nowMs), rules);
    if (!checked.ok) return checked;

    // §5/§15/§16: a task created paused carries no next run (mirrors PATCH
    // enabled:false) and may legitimately be a `once` whose time already passed.
    const enabled = input.enabled !== false;
    const nextRunAt = enabled ? nextRunIso(checked.rule, rules, nowMs) : null;
    if (enabled && !nextRunAt) {
      return fail('invalid_schedule_time', 'Rule has no upcoming run');
    }

    const row = repo.createTask({
      userId: input.userId ?? scope.userId ?? null,
      title,
      prompt: input.prompt,
      projectPath,
      provider: nonEmptyString(input.provider) || 'claude',
      model: nonEmptyString(input.model),
      kind: checked.rule.kind,
      ruleJson: JSON.stringify(checked.rule),
      nextRunAt,
      enabled,
      command: command ? command.value : undefined,
      commandTimeoutSeconds: commandTimeoutSeconds ? commandTimeoutSeconds.value : undefined,
      paramsJson: params ? params.value : undefined,
      presetId: nonEmptyString(input.presetId) ?? undefined,
      presetTaskId: nonEmptyString(input.presetTaskId) ?? undefined,
    });

    await ensureTaskWorkspaceBestEffort(row);
    return { ok: true, task: taskRowToJson(row) };
  }

  async function updateTask(id, patch = {}, scope = {}) {
    const repo = await getRepo();
    const rules = await getRules();

    const row = await findTask(id, scope);
    if (!row) return notFound();

    const changes = {};
    if (patch.title !== undefined) {
      const title = nonEmptyString(patch.title);
      if (!title) return fail('invalid_input', 'title must be a non-empty string');
      changes.title = title;
    }
    if (patch.prompt !== undefined) {
      if (typeof patch.prompt !== 'string' || !patch.prompt.trim()) {
        return fail('invalid_input', 'prompt must be a non-empty string');
      }
      changes.prompt = patch.prompt;
    }
    if (patch.projectPath !== undefined) {
      const projectPath = nonEmptyString(patch.projectPath);
      if (!projectPath) return fail('invalid_input', 'projectPath must be a non-empty string');
      changes.projectPath = projectPath;
    }
    if (patch.model !== undefined) {
      changes.model = nonEmptyString(patch.model);
    }
    if (patch.command !== undefined) {
      const checked = checkCommand(patch.command);
      if (!checked.ok) return checked;
      changes.command = checked.value;
    }
    if (patch.commandTimeoutSeconds !== undefined) {
      const checked = checkCommandTimeout(patch.commandTimeoutSeconds);
      if (!checked.ok) return checked;
      changes.commandTimeoutSeconds = checked.value;
    }
    if (patch.params !== undefined) {
      const checked = checkParams(patch.params);
      if (!checked.ok) return checked;
      changes.paramsJson = checked.value;
    }
    if (patch.presetId !== undefined) {
      changes.presetId = nonEmptyString(patch.presetId);
    }
    if (patch.presetTaskId !== undefined) {
      changes.presetTaskId = nonEmptyString(patch.presetTaskId);
    }

    const nowMs = now();
    let rule = null;
    if (hasValue(patch.rule)) {
      const checked = validateAndNormalize(withIntervalAnchor(patch.rule, nowMs), rules);
      if (!checked.ok) return checked;
      rule = checked.rule;
      changes.kind = rule.kind;
      changes.ruleJson = JSON.stringify(rule);
    }

    // undefined means "leave nextRunAt unchanged".
    let nextRunAt;
    if (rule) nextRunAt = nextRunIso(rule, rules, nowMs);

    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') {
        return fail('invalid_input', 'enabled must be a boolean');
      }
      changes.enabled = patch.enabled;
      if (!patch.enabled) {
        // Paused tasks are never due.
        nextRunAt = null;
      } else if (!rule && !row.enabled) {
        const storedRule = parseJson(row.rule_json ?? row.ruleJson);
        if (storedRule) nextRunAt = nextRunIso(storedRule, rules, nowMs);
      }
    }

    if (nextRunAt !== undefined) changes.nextRunAt = nextRunAt;

    const updated = repo.updateTask(id, changes);
    if (!updated) return notFound();
    await ensureTaskWorkspaceBestEffort(updated);
    return { ok: true, task: taskRowToJson(updated) };
  }

  async function setEnabled(id, enabled, scope = {}) {
    const repo = await getRepo();
    const rules = await getRules();
    const row = await findTask(id, scope);
    if (!row) return notFound();

    const changes = { enabled };
    if (!enabled) {
      changes.nextRunAt = null;
    } else if (!row.enabled) {
      const storedRule = parseJson(row.rule_json ?? row.ruleJson);
      const nextRunAt = storedRule ? nextRunIso(storedRule, rules, now()) : null;
      changes.nextRunAt = nextRunAt;
    }

    const updated = repo.updateTask(id, changes);
    if (!updated) return notFound();
    return { ok: true, task: taskRowToJson(updated) };
  }

  /**
   * @param {string} id
   * @param {object} [scope] { projectPath }
   * @param {object} [options] { purge } — §10.4: purge removes <root>/<taskId>
   */
  async function deleteTask(id, scope = {}, options = {}) {
    const repo = await getRepo();
    const row = await findTask(id, scope);
    if (!row) return notFound();
    const deleted = repo.deleteTask(id);
    if (!deleted) return notFound();
    let purged = false;
    if (options && options.purge) purged = await purgeTaskWorkspace(id);
    return { ok: true, id, deleted: true, purged };
  }

  /**
   * @param {string} id
   * @param {object} [scope] { projectPath }
   * @param {object} [options] { params } — §12.3 per-run override map
   */
  async function runTaskNow(id, scope = {}, options = {}) {
    const row = await findTask(id, scope);
    if (!row) return notFound();

    const overrides = options.params;
    const hasOverrides = overrides !== undefined && overrides !== null;
    if (hasOverrides) {
      // §12.3: an override naming an undeclared parameter, or an uncoercible
      // value, is invalid_input at request time. A missing *required* parameter
      // is deliberately not rejected here: the run is created and records
      // missing_required_param on its run row (no gate, no agent call).
      const checked = resolveParams(parseParamDefs(row.params_json ?? row.paramsJson), overrides);
      if (!checked.ok && checked.code === 'invalid_input') return fail(checked.code, checked.message);
    }

    const runNow = await getRunNow();
    let result;
    try {
      result = hasOverrides ? await runNow(id, { params: overrides }) : await runNow(id);
    } catch (err) {
      return fail('internal_error', errorMessage(err), 500);
    }

    if (!result || result.error === 'not_found') return notFound();
    if (result.error === 'in_flight') {
      return fail('in_flight', 'Scheduled task is already running', 409);
    }
    if (result.error || !result.run) {
      return fail('internal_error', result.error || 'No run was created', 500);
    }
    return { ok: true, run: runRowToJson(result.run) };
  }

  // ─── Copy / import / export (§15, §16) ──────────────────────────────────────

  /**
   * §15: duplicate a task. The copy keeps the definition (prompt, provider,
   * model, script gate, params and rule) but never the run history, the run
   * counters, the preset link or the last-status fields. It is created *paused*
   * unless the caller explicitly passes enabled:true, so copying can never
   * silently double a running schedule.
   */
  async function copyTask(id, options = {}, scope = {}) {
    const repo = await getRepo();
    const rules = await getRules();
    const row = await findTask(id, scope);
    if (!row) return notFound();

    const title = nonEmptyString(options.title) || `${row.title} (copy)`;
    const projectPath =
      nonEmptyString(options.projectPath) || nonEmptyString(row.project_path ?? row.projectPath);
    if (!projectPath) return fail('invalid_input', 'projectPath is required');

    // §15: the rule is carried over unchanged (an interval keeps its original
    // anchor, so the copy shares the original cadence rather than restarting it).
    const storedRule = parseJson(row.rule_json ?? row.ruleJson);
    const checked = validateAndNormalize(withIntervalAnchor(storedRule, now()), rules);
    if (!checked.ok) return checked;

    const enabled = options.enabled === true;
    const nowMs = now();
    const nextRunAt = enabled ? nextRunIso(checked.rule, rules, nowMs) : null;
    if (enabled && !nextRunAt) {
      return fail('invalid_schedule_time', 'Rule has no upcoming run');
    }

    const created = repo.createTask({
      userId: options.userId ?? row.user_id ?? row.userId ?? null,
      title,
      prompt: row.prompt,
      projectPath,
      provider: row.provider ?? 'claude',
      model: row.model ?? null,
      kind: checked.rule.kind,
      ruleJson: JSON.stringify(checked.rule),
      nextRunAt,
      enabled,
      command: row.command ?? null,
      commandTimeoutSeconds: row.command_timeout_seconds ?? null,
      paramsJson: row.params_json ?? row.paramsJson ?? null,
    });
    await ensureTaskWorkspaceBestEffort(created);
    return { ok: true, task: taskRowToJson(created) };
  }

  /**
   * §16: the portable form of one task. Ids, run history, preset linkage and
   * the counters are deliberately absent: the envelope is a shareable template.
   */
  async function exportTask(id, scope = {}) {
    const row = await findTask(id, scope);
    if (!row) return notFound();
    const task = taskRowToJson(row);
    return {
      ok: true,
      format: TASK_EXPORT_FORMAT,
      version: TASK_EXPORT_VERSION,
      exportedAt: new Date(now()).toISOString(),
      task: {
        title: task.title,
        prompt: task.prompt,
        projectPath: task.projectPath,
        provider: task.provider,
        model: task.model,
        command: task.command,
        commandTimeoutSeconds: task.commandTimeoutSeconds,
        params: task.params ?? [],
        rule: task.rule,
      },
    };
  }

  /**
   * §16: materialize an exported envelope (or a raw task definition) into a new
   * paused task. The target project resolves as input.projectPath &gt; envelope
   * projectPath &gt; the caller scope; the format/version are validated so a
   * foreign JSON file fails loudly instead of creating a half-empty task.
   */
  async function importTask(input = {}, scope = {}) {
    const envelope = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (envelope.format !== undefined && envelope.format !== TASK_EXPORT_FORMAT) {
      return fail('invalid_input', `Unsupported task format: ${String(envelope.format)}`);
    }
    if (envelope.version !== undefined && Number(envelope.version) !== TASK_EXPORT_VERSION) {
      return fail('invalid_input', `Unsupported task format version: ${String(envelope.version)}`);
    }
    const candidate =
      envelope.task && typeof envelope.task === 'object' && !Array.isArray(envelope.task)
        ? envelope.task
        : envelope;
    if (!nonEmptyString(candidate.title) && !nonEmptyString(input.title)) {
      return fail('invalid_input', 'title is required');
    }
    const projectPath =
      nonEmptyString(input.projectPath) ||
      nonEmptyString(candidate.projectPath) ||
      nonEmptyString(scope.projectPath);
    if (!projectPath) return fail('invalid_input', 'projectPath is required');
    const enabled = input.enabled !== undefined ? input.enabled === true : candidate.enabled === true;
    return createTask(
      {
        userId: input.userId ?? scope.userId ?? null,
        title: nonEmptyString(input.title) || candidate.title,
        prompt: candidate.prompt,
        projectPath,
        provider: candidate.provider,
        model: candidate.model,
        command: candidate.command,
        commandTimeoutSeconds: candidate.commandTimeoutSeconds,
        params: candidate.params,
        rule: candidate.rule,
        enabled,
      },
      scope
    );
  }

  return {
    // views
    taskView: taskRowToJson,
    runView: runRowToJson,
    // selectors
    ruleFromArgs: (args, options) => ruleFromArgs(args, now(), options),
    // queries
    listTasks,
    getTask,
    listRuns,
    getTaskWithRuns,
    countRunningTasks,
    // mutations
    createTask,
    updateTask,
    pauseTask: (id, scope) => setEnabled(id, false, scope),
    resumeTask: (id, scope) => setEnabled(id, true, scope),
    deleteTask,
    runTaskNow,
    // §15/§16 copy + portability
    copyTask,
    exportTask,
    importTask,
    // §10.3 presets — same service for the REST routes and the agent tools.
    presets: {
      listPresets: (options) => getPresetsService().then((service) => service.listPresets(options)),
      getPreset: (id, options) => getPresetsService().then((service) => service.getPreset(id, options)),
      installPreset: (id, options) => getPresetsService().then((service) => service.installPreset(id, options)),
      setPresetEnabled: (id, enabled, options) =>
        getPresetsService().then((service) => service.setPresetEnabled(id, enabled, options)),
      upgradePreset: (id, options) =>
        getPresetsService().then((service) => service.upgradePreset(id, options)),
      createCustomPreset: (input) => getPresetsService().then((service) => service.createCustomPreset(input)),
      updatePreset: (id, patch, options) =>
        getPresetsService().then((service) => service.updatePreset(id, patch, options)),
      deletePreset: (id, options, scope) =>
        getPresetsService().then((service) => service.deletePreset(id, options, scope)),
    },
  };
}
