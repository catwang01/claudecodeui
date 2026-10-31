import crypto from 'crypto';
import { getConnection } from '@/modules/database/connection.js';

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
};

// docs section 9.1: which scheduled task started a session (the newest run wins).
export type ScheduledTaskSessionOrigin = {
  taskId: string;
  taskTitle: string;
  startedAt: string | null;
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

const INSERT_TASK_SQL =
  'INSERT INTO scheduled_tasks (id, user_id, title, prompt, project_path, provider, model, kind, rule_json, ' +
  'next_run_at, last_run_at, last_status, last_error, enabled, run_count, created_at, updated_at, ' +
  'command, command_timeout_seconds) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, ?, ?, ?, ?)';

const INSERT_RUN_SQL =
  'INSERT INTO scheduled_task_runs (id, task_id, status, "trigger", scheduled_for, started_at, finished_at, session_id, output, error, script_exit_code, script_output, prompt_used) ' +
  'VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)';

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
        pick(input.commandTimeoutSeconds, input.command_timeout_seconds) ?? null
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
        pick(input.promptUsed, input.prompt_used) ?? null
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

  pruneRuns(taskId: string, keep = 50): number {
    const sql =
      'DELETE FROM scheduled_task_runs WHERE task_id = ? AND id NOT IN (' +
      'SELECT id FROM scheduled_task_runs WHERE task_id = ? ' +
      'ORDER BY started_at DESC, rowid DESC LIMIT ?)';
    const info = getConnection().prepare(sql).run(taskId, taskId, keep);
    return info.changes;
  },
};
