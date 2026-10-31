import crypto from 'crypto';
import { getConnection } from '@/modules/database/connection.js';
import { normalizeProjectPath } from '@/shared/utils.js';

export type ScheduledTaskRow = {
  id: string;
  user_id: number | null;
  title: string;
  prompt: string;
  project_path: string;
  provider: string;
  model: string | null;
  kind: string;
  rule_json: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  enabled: number;
  run_count: number;
  created_at: string;
  updated_at: string;
  command: string | null;
  command_timeout_seconds: number | null;
  // Parameter definitions (docs section 12.4); NULL/'' means "no parameters".
  params_json: string | null;
  // Preset installation link (docs section 10.2); NULL for ad-hoc tasks.
  preset_id: string | null;
  preset_task_id: string | null;
  // Conflict policy (docs section 17); NULL on rows created before the feature,
  // which read as 'skip'.
  conflict_policy: string | null;
  // Tags (docs section 19) as JSON string[]; NULL/'' means "no tags".
  tags_json: string | null;
};

export type ScheduledTaskRunRow = {
  id: string;
  task_id: string;
  status: string;
  trigger: string;
  scheduled_for: string | null;
  started_at: string;
  finished_at: string | null;
  session_id: string | null;
  output: string | null;
  error: string | null;
  script_exit_code: number | null;
  script_output: string | null;
  prompt_used: string | null;
  // Resolved parameter values of this run (docs section 12.4).
  params_json: string | null;
  // docs section 14.1: ISO-8601 UTC of the moment the runner started the agent.
  // NULL while the run is in the script gate, and for every run that ends as
  // skipped / gate-error / params-error / unsupported-provider.
  agent_started_at: string | null;
};

// docs section 9.1: which scheduled task started a session (the newest run wins).
export type ScheduledTaskSessionOrigin = {
  taskId: string;
  taskTitle: string;
  startedAt: string | null;
};

// Presets (docs section 10.2). `source` is 'builtin' | 'custom'; `project_path` is set
// for custom presets only; `enabled` is the whole-preset switch.
export type ScheduledTaskPresetRow = {
  id: string;
  user_id: number | null;
  source: string;
  name: string;
  description: string | null;
  icon: string | null;
  version: string | null;
  enabled: number;
  project_path: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduledTaskPresetTaskRow = {
  id: string;
  preset_id: string;
  title: string;
  description: string | null;
  prompt: string;
  provider: string;
  model: string | null;
  kind: string;
  rule_json: string;
  command: string | null;
  command_timeout_seconds: number | null;
  // Template parameter definitions (docs section 12.4), copied into the task on install.
  params_json: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export type CreateScheduledTaskPresetInput = {
  id?: string;
  userId?: number | null;
  source: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  version?: string | null;
  enabled?: boolean | number;
  projectPath?: string | null;
};

export type ScheduledTaskPresetPatch = Partial<{
  name: string;
  description: string | null;
  icon: string | null;
  version: string | null;
  enabled: boolean | number;
  projectPath: string | null;
  userId: number | null;
}>;

export type ListScheduledTaskPresetsOptions = {
  source?: 'builtin' | 'custom' | string;
  projectPath?: string | null;
};

// One template of a preset. `rule` (object) and `ruleJson` (already serialized) are
// both accepted; `ruleJson` wins when both are supplied.
export type PresetTaskInput = {
  id?: string;
  title: string;
  description?: string | null;
  prompt: string;
  provider?: string;
  model?: string | null;
  kind: string;
  rule?: unknown;
  ruleJson?: string;
  command?: string | null;
  commandTimeoutSeconds?: number | null;
  command_timeout_seconds?: number | null;
  // docs section 12.4: template ParamDef[] as JSON.
  paramsJson?: string | null;
  params_json?: string | null;
  // Defaults to the array index in replacePresetTasks().
  position?: number;
};

// Inputs are camelCase, rows are snake_case (docs §7). The snake_case spellings
// are accepted as aliases so callers that already hold a row can spread it in.
export type CreateScheduledTaskInput = {
  id?: string;
  userId?: number | null;
  title: string;
  prompt: string;
  projectPath: string;
  provider?: string;
  model?: string | null;
  kind: string;
  ruleJson: string;
  nextRunAt?: string | null;
  enabled?: boolean | number;
  command?: string | null;
  commandTimeoutSeconds?: number | null;
  command_timeout_seconds?: number | null;
  // docs section 12.4: ParamDef[] as JSON; NULL/'' means "no parameters".
  paramsJson?: string | null;
  params_json?: string | null;
  presetId?: string | null;
  presetTaskId?: string | null;
  // docs section 17: 'skip' | 'queue' | 'replace'; defaults to 'skip'.
  conflictPolicy?: string | null;
  // docs section 19: JSON string[]; NULL/'' means "no tags".
  tagsJson?: string | null;
  tags_json?: string | null;
};

export type ScheduledTaskUpdatePatch = Partial<{
  title: string;
  prompt: string;
  projectPath: string;
  provider: string;
  model: string | null;
  kind: string;
  ruleJson: string;
  nextRunAt: string | null;
  enabled: boolean | number;
  command: string | null;
  commandTimeoutSeconds: number | null;
  command_timeout_seconds: number | null;
  paramsJson: string | null;
  params_json: string | null;
  presetId: string | null;
  presetTaskId: string | null;
  conflictPolicy: string | null;
  tagsJson: string | null;
  tags_json: string | null;
}>;

export type ScheduledTaskAdvancePatch = Partial<{
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number;
}>;

export type CreateScheduledTaskRunInput = {
  taskId: string;
  status: string;
  trigger: string;
  scheduledFor?: string | null;
  startedAt?: string;
  scriptExitCode?: number | null;
  scriptOutput?: string | null;
  promptUsed?: string | null;
  script_exit_code?: number | null;
  script_output?: string | null;
  prompt_used?: string | null;
  // docs section 12.4: resolved value map as JSON.
  paramsJson?: string | null;
  params_json?: string | null;
};

export type FinishScheduledTaskRunPatch = {
  status: string;
  finishedAt?: string;
  sessionId?: string | null;
  output?: string | null;
  error?: string | null;
  scriptExitCode?: number | null;
  scriptOutput?: string | null;
  promptUsed?: string | null;
  script_exit_code?: number | null;
  script_output?: string | null;
  prompt_used?: string | null;
};

export type ListScheduledTasksOptions = {
  userId?: number | null;
  status?: 'active' | 'paused' | 'all';
  search?: string;
};

type ColumnValue = string | number | null;

const currentIso = (): string => new Date().toISOString();

const toEnabled = (value: boolean | number | undefined): number => (value === undefined || value ? 1 : 0);

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => '\\' + char);

// First value that was actually supplied (undefined means "not supplied", null means "clear").
const pick = <T>(...values: (T | undefined)[]): T | undefined => values.find((value) => value !== undefined);

function pushAssignment(assignments: string[], values: ColumnValue[], column: string, value: ColumnValue | undefined): void {
  if (value === undefined) return;
  assignments.push(column + ' = ?');
  values.push(value);
}

function selectTask(id: string): ScheduledTaskRow | undefined {
  return getConnection().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTaskRow | undefined;
}

function selectRun(id: string): ScheduledTaskRunRow | undefined {
  return getConnection().prepare('SELECT * FROM scheduled_task_runs WHERE id = ?').get(id) as ScheduledTaskRunRow | undefined;
}

function selectPreset(id: string): ScheduledTaskPresetRow | undefined {
  return getConnection().prepare('SELECT * FROM scheduled_task_presets WHERE id = ?').get(id) as
    | ScheduledTaskPresetRow
    | undefined;
}

// docs section 10.2: the same comparison the management layer uses to scope tasks to a
// project (server/scheduled-tasks/management.js#sameProjectPath), so custom presets are
// filtered exactly like custom tasks.
function sameProjectPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  let left = a;
  let right = b;
  try {
    left = normalizeProjectPath(a);
    right = normalizeProjectPath(b);
  } catch {
    // Keep the raw values when the path cannot be resolved.
  }
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function selectPresetTasks(presetId: string): ScheduledTaskPresetTaskRow[] {
  return getConnection()
    .prepare(
      'SELECT * FROM scheduled_task_preset_tasks WHERE preset_id = ? ' +
        'ORDER BY position ASC, created_at ASC, rowid ASC'
    )
    .all(presetId) as ScheduledTaskPresetTaskRow[];
}

function selectTasksByPreset(presetId: string): ScheduledTaskRow[] {
  return getConnection()
    .prepare('SELECT * FROM scheduled_tasks WHERE preset_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(presetId) as ScheduledTaskRow[];
}

// A preset template carries either a rule object or an already serialized ruleJson.
function serializeRule(task: PresetTaskInput): string {
  if (typeof task.ruleJson === 'string') return task.ruleJson;
  if (typeof task.rule === 'string') return task.rule;
  return JSON.stringify(task.rule ?? {});
}

const INSERT_TASK_SQL =
  'INSERT INTO scheduled_tasks (id, user_id, title, prompt, project_path, provider, model, kind, rule_json, ' +
  'next_run_at, last_run_at, last_status, last_error, enabled, run_count, created_at, updated_at, ' +
  'command, command_timeout_seconds, params_json, preset_id, preset_task_id, conflict_policy, tags_json) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const INSERT_PRESET_SQL =
  'INSERT INTO scheduled_task_presets (id, user_id, source, name, description, icon, version, enabled, ' +
  'project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const INSERT_PRESET_TASK_SQL =
  'INSERT INTO scheduled_task_preset_tasks (id, preset_id, title, description, prompt, provider, model, kind, ' +
  'rule_json, command, command_timeout_seconds, params_json, position, created_at, updated_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const INSERT_RUN_SQL =
  'INSERT INTO scheduled_task_runs (id, task_id, status, "trigger", scheduled_for, started_at, finished_at, session_id, output, error, script_exit_code, script_output, prompt_used, params_json) ' +
  'VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)';

// docs section 9.1: one row per run, LEFT JOIN so a run whose task row is gone still resolves
// (title falls back to the task id). The correlated rowid pick keeps exactly the newest run
// per session, with rowid as a deterministic tie-breaker.
const SESSION_ORIGINS_SQL_PREFIX =
  'SELECT r.session_id AS session_id, r.task_id AS task_id, ' +
  'COALESCE(t.title, r.task_id) AS task_title, r.started_at AS started_at ' +
  'FROM scheduled_task_runs r LEFT JOIN scheduled_tasks t ON t.id = r.task_id ' +
  'WHERE r.session_id IN (';
const SESSION_ORIGINS_SQL_SUFFIX =
  ') AND r.rowid = (' +
  'SELECT r2.rowid FROM scheduled_task_runs r2 WHERE r2.session_id = r.session_id ' +
  'ORDER BY r2.started_at DESC, r2.rowid DESC LIMIT 1) ' +
  'ORDER BY r.session_id ASC';

export const scheduledTasksDb = {
  createTask(input: CreateScheduledTaskInput): ScheduledTaskRow {
    const id = input.id ?? crypto.randomUUID();
    const timestamp = currentIso();
    getConnection()
      .prepare(INSERT_TASK_SQL)
      .run(
        id,
        input.userId ?? null,
        input.title,
        input.prompt,
        input.projectPath,
        input.provider ?? 'claude',
        input.model ?? null,
        input.kind,
        input.ruleJson,
        input.nextRunAt ?? null,
        toEnabled(input.enabled),
        timestamp,
        timestamp,
        input.command ?? null,
        pick(input.commandTimeoutSeconds, input.command_timeout_seconds) ?? null,
        pick(input.paramsJson, input.params_json) ?? null,
        input.presetId ?? null,
        input.presetTaskId ?? null,
        input.conflictPolicy ?? 'skip',
        pick(input.tagsJson, input.tags_json) ?? null
      );
    return selectTask(id) as ScheduledTaskRow;
  },

  getTask(id: string): ScheduledTaskRow | undefined {
    return selectTask(id);
  },

  listTasks(options: ListScheduledTasksOptions = {}): ScheduledTaskRow[] {
    const where: string[] = [];
    const values: ColumnValue[] = [];

    if (typeof options.userId === 'number') {
      // Unowned rows belong to whoever created them without an HTTP user context
      // (the agent tools). They must stay visible to the authenticated user;
      // only another user's tasks are filtered out.
      where.push('(user_id = ? OR user_id IS NULL)');
      values.push(options.userId);
    }
    if (options.status === 'active') where.push('enabled = 1');
    else if (options.status === 'paused') where.push('enabled = 0');

    if (typeof options.search === 'string' && options.search.trim() !== '') {
      const term = '%' + escapeLike(options.search.trim()) + '%';
      where.push("(title LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\' OR project_path LIKE ? ESCAPE '\\')");
      values.push(term, term, term);
    }

    const sql =
      'SELECT * FROM scheduled_tasks' +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY created_at DESC, rowid DESC';
    return getConnection().prepare(sql).all(...values) as ScheduledTaskRow[];
  },

  updateTask(id: string, patch: ScheduledTaskUpdatePatch = {}): ScheduledTaskRow | undefined {
    const assignments: string[] = [];
    const values: ColumnValue[] = [];

    pushAssignment(assignments, values, 'title', patch.title);
    pushAssignment(assignments, values, 'prompt', patch.prompt);
    pushAssignment(assignments, values, 'project_path', patch.projectPath);
    pushAssignment(assignments, values, 'provider', patch.provider);
    pushAssignment(assignments, values, 'model', patch.model);
    pushAssignment(assignments, values, 'kind', patch.kind);
    pushAssignment(assignments, values, 'rule_json', patch.ruleJson);
    pushAssignment(assignments, values, 'next_run_at', patch.nextRunAt);
    pushAssignment(assignments, values, 'command', patch.command);
    pushAssignment(assignments, values, 'command_timeout_seconds', pick(patch.commandTimeoutSeconds, patch.command_timeout_seconds));
    pushAssignment(assignments, values, 'params_json', pick(patch.paramsJson, patch.params_json));
    pushAssignment(assignments, values, 'preset_id', patch.presetId);
    pushAssignment(assignments, values, 'preset_task_id', patch.presetTaskId);
    pushAssignment(assignments, values, 'conflict_policy', patch.conflictPolicy);
    pushAssignment(assignments, values, 'tags_json', pick(patch.tagsJson, patch.tags_json));
    if (patch.enabled !== undefined) pushAssignment(assignments, values, 'enabled', toEnabled(patch.enabled));

    assignments.push('updated_at = ?');
    values.push(currentIso());
    values.push(id);

    const info = getConnection()
      .prepare('UPDATE scheduled_tasks SET ' + assignments.join(', ') + ' WHERE id = ?')
      .run(...values);
    if (info.changes === 0) return undefined;
    return selectTask(id);
  },

  deleteTask(id: string): boolean {
    const info = getConnection().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    return info.changes > 0;
  },

  listDueTasks(nowIso: string, limit = 50): ScheduledTaskRow[] {
    const sql =
      'SELECT * FROM scheduled_tasks ' +
      'WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ' +
      'ORDER BY next_run_at ASC, rowid ASC LIMIT ?';
    return getConnection().prepare(sql).all(nowIso, limit) as ScheduledTaskRow[];
  },

  advanceTask(id: string, patch: ScheduledTaskAdvancePatch = {}): ScheduledTaskRow | undefined {
    const assignments: string[] = [];
    const values: ColumnValue[] = [];

    pushAssignment(assignments, values, 'next_run_at', patch.nextRunAt);
    pushAssignment(assignments, values, 'last_run_at', patch.lastRunAt);
    pushAssignment(assignments, values, 'last_status', patch.lastStatus);
    pushAssignment(assignments, values, 'last_error', patch.lastError);
    pushAssignment(assignments, values, 'run_count', patch.runCount);

    assignments.push('updated_at = ?');
    values.push(currentIso());
    values.push(id);

    const info = getConnection()
      .prepare('UPDATE scheduled_tasks SET ' + assignments.join(', ') + ' WHERE id = ?')
      .run(...values);
    if (info.changes === 0) return undefined;
    return selectTask(id);
  },

  createRun(input: CreateScheduledTaskRunInput): ScheduledTaskRunRow {
    const id = crypto.randomUUID();
    getConnection()
      .prepare(INSERT_RUN_SQL)
      .run(
        id,
        input.taskId,
        input.status,
        input.trigger,
        input.scheduledFor ?? null,
        input.startedAt ?? currentIso(),
        pick(input.scriptExitCode, input.script_exit_code) ?? null,
        pick(input.scriptOutput, input.script_output) ?? null,
        pick(input.promptUsed, input.prompt_used) ?? null,
        pick(input.paramsJson, input.params_json) ?? null
      );
    return selectRun(id) as ScheduledTaskRunRow;
  },

  finishRun(id: string, patch: FinishScheduledTaskRunPatch): ScheduledTaskRunRow | undefined {
    const assignments: string[] = ['status = ?', 'finished_at = ?'];
    const values: ColumnValue[] = [patch.status, patch.finishedAt ?? currentIso()];

    pushAssignment(assignments, values, 'session_id', patch.sessionId);
    pushAssignment(assignments, values, 'output', patch.output);
    pushAssignment(assignments, values, 'error', patch.error);
    pushAssignment(assignments, values, 'script_exit_code', pick(patch.scriptExitCode, patch.script_exit_code));
    pushAssignment(assignments, values, 'script_output', pick(patch.scriptOutput, patch.script_output));
    pushAssignment(assignments, values, 'prompt_used', pick(patch.promptUsed, patch.prompt_used));
    values.push(id);

    const info = getConnection()
      .prepare('UPDATE scheduled_task_runs SET ' + assignments.join(', ') + ' WHERE id = ?')
      .run(...values);
    if (info.changes === 0) return undefined;
    return selectRun(id);
  },

  /**
   * Link a run to the agent session it started as soon as that session exists, so the
   * origin tag and the hide filter work while the run is still in flight — finishRun
   * otherwise records the id minutes later, after the session is already in the sidebar.
   */
  attachRunSession(id: string, sessionId: string): ScheduledTaskRunRow | undefined {
    const info = getConnection()
      .prepare('UPDATE scheduled_task_runs SET session_id = ? WHERE id = ?')
      .run(sessionId, id);
    if (info.changes === 0) return undefined;
    return selectRun(id);
  },

  /**
   * docs section 14.1: record the moment the runner actually decided to call the
   * agent. Idempotent / write-once — a second call never moves the timestamp, so
   * a retried mark cannot make a long run look freshly started.
   */
  markRunAgentStarted(id: string): ScheduledTaskRunRow | undefined {
    getConnection()
      .prepare(
        'UPDATE scheduled_task_runs SET agent_started_at = ? WHERE id = ? AND agent_started_at IS NULL'
      )
      .run(currentIso(), id);
    return selectRun(id);
  },

  /**
   * docs section 14.1: how many distinct tasks have an agent-started run in
   * flight. A task can only own one run at a time, so this is also the number of
   * "running" tasks the UI shows; gate-phase / skipped runs are excluded.
   */
  countRunningAgentRuns(): number {
    const row = getConnection()
      .prepare(
        'SELECT COUNT(DISTINCT task_id) AS count FROM scheduled_task_runs ' +
          "WHERE status = 'running' AND agent_started_at IS NOT NULL"
      )
      .get() as { count: number } | undefined;
    return row ? row.count : 0;
  },

  /**
   * docs section 14.1: fail every run left 'running' by a previous process. The
   * agent is a child of this process, so after a restart it can only be gone;
   * leaving the rows 'running' would inflate the running-task count forever.
   * Returns the number of rows that were interrupted.
   */
  failInterruptedRuns(finishedAt: string, error: string): number {
    const info = getConnection()
      .prepare(
        "UPDATE scheduled_task_runs SET status = 'error', finished_at = ?, error = ? " +
          "WHERE status = 'running'"
      )
      .run(finishedAt, error);
    return info.changes;
  },

  listRuns(taskId: string, limit = 20, offset = 0): ScheduledTaskRunRow[] {
    const sql =
      'SELECT * FROM scheduled_task_runs WHERE task_id = ? ' +
      'ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?';
    return getConnection().prepare(sql).all(taskId, limit, offset) as ScheduledTaskRunRow[];
  },

  countRuns(taskId: string): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ?')
      .get(taskId) as { count: number } | undefined;
    return row ? row.count : 0;
  },

  // docs section 9.1: the authoritative session -> task mapping, one query. Repeated runs of
  // the same session collapse to the newest started_at; empty input short-circuits.
  getSessionOrigins(sessionIds: string[]): Map<string, ScheduledTaskSessionOrigin> {
    const origins = new Map<string, ScheduledTaskSessionOrigin>();
    const ids = Array.from(new Set(sessionIds)).filter((id) => typeof id === 'string' && id !== '');
    if (ids.length === 0) return origins;

    const placeholders = ids.map(() => '?').join(', ');
    const rows = getConnection()
      .prepare(SESSION_ORIGINS_SQL_PREFIX + placeholders + SESSION_ORIGINS_SQL_SUFFIX)
      .all(...ids) as { session_id: string; task_id: string; task_title: string; started_at: string | null }[];

    for (const row of rows) {
      origins.set(row.session_id, {
        taskId: row.task_id,
        taskTitle: row.task_title,
        startedAt: row.started_at,
      });
    }
    return origins;
  },

  // docs section 9.1: every session id a scheduled task ever started, in one query.
  getAllScheduledTaskSessionIds(): Set<string> {
    const rows = getConnection()
      .prepare('SELECT DISTINCT session_id FROM scheduled_task_runs WHERE session_id IS NOT NULL')
      .all() as { session_id: string }[];
    return new Set(rows.map((row) => row.session_id));
  },

  // ── Presets (docs section 10.2) ──────────────────────────────────────────

  createPreset(input: CreateScheduledTaskPresetInput): ScheduledTaskPresetRow {
    const id = input.id ?? crypto.randomUUID();
    const timestamp = currentIso();
    getConnection()
      .prepare(INSERT_PRESET_SQL)
      .run(
        id,
        input.userId ?? null,
        input.source,
        input.name,
        input.description ?? null,
        input.icon ?? null,
        input.version ?? null,
        // Unlike tasks, a preset stays disabled until it is installed/enabled.
        input.enabled === undefined ? 0 : toEnabled(input.enabled),
        input.projectPath ?? null,
        timestamp,
        timestamp
      );
    return selectPreset(id) as ScheduledTaskPresetRow;
  },

  getPreset(id: string): ScheduledTaskPresetRow | undefined {
    return selectPreset(id);
  },

  // Builtin rows are returned for every project; custom rows only when their project
  // matches. Omitting projectPath returns all rows (source filter still applies).
  listPresets(options: ListScheduledTaskPresetsOptions = {}): ScheduledTaskPresetRow[] {
    const where: string[] = [];
    const values: ColumnValue[] = [];
    if (options.source) {
      where.push('source = ?');
      values.push(options.source);
    }

    const sql =
      'SELECT * FROM scheduled_task_presets' +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY source ASC, name COLLATE NOCASE ASC, rowid ASC';
    const rows = getConnection().prepare(sql).all(...values) as ScheduledTaskPresetRow[];

    const { projectPath } = options;
    if (projectPath === undefined) return rows;
    return rows.filter((row) => row.source !== 'custom' || sameProjectPath(row.project_path, projectPath));
  },

  updatePreset(id: string, patch: ScheduledTaskPresetPatch = {}): ScheduledTaskPresetRow | undefined {
    const assignments: string[] = [];
    const values: ColumnValue[] = [];

    pushAssignment(assignments, values, 'name', patch.name);
    pushAssignment(assignments, values, 'description', patch.description);
    pushAssignment(assignments, values, 'icon', patch.icon);
    pushAssignment(assignments, values, 'version', patch.version);
    pushAssignment(assignments, values, 'project_path', patch.projectPath);
    pushAssignment(assignments, values, 'user_id', patch.userId);
    if (patch.enabled !== undefined) pushAssignment(assignments, values, 'enabled', toEnabled(patch.enabled));

    assignments.push('updated_at = ?');
    values.push(currentIso());
    values.push(id);

    const info = getConnection()
      .prepare('UPDATE scheduled_task_presets SET ' + assignments.join(', ') + ' WHERE id = ?')
      .run(...values);
    if (info.changes === 0) return undefined;
    return selectPreset(id);
  },

  // Drops the preset and its templates. The installed tasks are not touched here: the
  // service decides whether they are deleted or unlinked.
  deletePreset(id: string): boolean {
    const db = getConnection();
    const remove = db.transaction((presetId: string): boolean => {
      // Explicit delete (not relying on ON DELETE CASCADE) so the rows go even when the
      // foreign_keys pragma is off.
      db.prepare('DELETE FROM scheduled_task_preset_tasks WHERE preset_id = ?').run(presetId);
      return db.prepare('DELETE FROM scheduled_task_presets WHERE id = ?').run(presetId).changes > 0;
    });
    return remove(id);
  },

  // Full replacement of the template list, atomically. `position` defaults to the array
  // index, so callers that pass a catalog order get it preserved.
  replacePresetTasks(presetId: string, tasks: PresetTaskInput[]): ScheduledTaskPresetTaskRow[] {
    // A missing parent would surface as a raw FOREIGN KEY error; report "no templates".
    if (!selectPreset(presetId)) return [];

    const db = getConnection();
    const timestamp = currentIso();
    const replace = db.transaction((inputs: PresetTaskInput[]) => {
      db.prepare('DELETE FROM scheduled_task_preset_tasks WHERE preset_id = ?').run(presetId);
      const insert = db.prepare(INSERT_PRESET_TASK_SQL);
      inputs.forEach((task, index) => {
        insert.run(
          task.id ?? crypto.randomUUID(),
          presetId,
          task.title,
          task.description ?? null,
          task.prompt,
          task.provider ?? 'claude',
          task.model ?? null,
          task.kind,
          serializeRule(task),
          task.command ?? null,
          pick(task.commandTimeoutSeconds, task.command_timeout_seconds) ?? null,
          pick(task.paramsJson, task.params_json) ?? null,
          task.position ?? index,
          timestamp,
          timestamp
        );
      });
    });
    replace(tasks);
    return selectPresetTasks(presetId);
  },

  listPresetTasks(presetId: string): ScheduledTaskPresetTaskRow[] {
    return selectPresetTasks(presetId);
  },

  // The real tasks a preset materialized, oldest first.
  listTasksByPreset(presetId: string): ScheduledTaskRow[] {
    return selectTasksByPreset(presetId);
  },

  pruneRuns(taskId: string, keep = 50): number {
    const sql =
      'DELETE FROM scheduled_task_runs WHERE task_id = ? AND id NOT IN (' +
      'SELECT id FROM scheduled_task_runs WHERE task_id = ? ' +
      'ORDER BY started_at DESC, rowid DESC LIMIT ?)';
    const info = getConnection().prepare(sql).run(taskId, taskId, keep);
    return info.changes;
  },
};
