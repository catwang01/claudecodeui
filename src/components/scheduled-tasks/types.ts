/**
 * Shared types for the scheduled-tasks feature.
 *
 * Mirrors the frozen REST contract in docs/scheduled-tasks.md (section 5).
 */

export type RuleKind = 'once' | 'interval' | 'daily' | 'weekly' | 'cron';

/** Parameter value kinds supported by a scheduled task (section 12.1). */
export type ParamType = 'string' | 'number' | 'boolean';

/**
 * One declared task parameter (docs/scheduled-tasks.md section 12.1).
 *
 * Parameters are resolved into a flat string map at run time and exported to
 * the script gate and the agent runtime as SCHEDULED_TASK_PARAM_<NAME> env
 * vars, plus SCHEDULED_TASK_PARAMS as compact JSON.
 */
export interface ParamDef {
  /** ^[A-Za-z_][A-Za-z0-9_]{0,63}$, unique case-insensitively within a task. */
  name: string;
  /** Defaults to 'string'. */
  type?: ParamType;
  default?: string | number | boolean;
  /** Free-form help text, at most 500 characters. */
  description?: string;
  /** Defaults to false; only meaningful without a default. */
  required?: boolean;
}

/**
 * Shape of the `rule` object as returned by the API. The backend may or may not
 * echo `kind` inside the rule, so every field is optional and validated by the
 * normalizers in utils/rules.ts.
 */
export interface RulePayload {
  kind?: string;
  at?: string;
  everySeconds?: number;
  time?: string;
  timeZone?: string;
  weekdays?: number[];
  expression?: string;
}

export interface OnceRule {
  kind: 'once';
  at: string;
}

export interface IntervalRule {
  kind: 'interval';
  everySeconds: number;
}

export interface DailyRule {
  kind: 'daily';
  time: string;
  timeZone: string;
}

export interface WeeklyRule {
  kind: 'weekly';
  time: string;
  timeZone: string;
  weekdays: number[];
}

export interface CronRule {
  kind: 'cron';
  expression: string;
  timeZone: string;
}

export type TaskRule = OnceRule | IntervalRule | DailyRule | WeeklyRule | CronRule;

export type IntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days';

/** Editable, HTML-input-friendly representation of a rule. */
export interface RuleDraft {
  kind: RuleKind;
  /** `datetime-local` value for kind 'once'. */
  onceAt: string;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  /** 'HH:mm' local wall clock. */
  time: string;
  timeZone: string;
  /** ISO weekdays, Mon = 1 ... Sun = 7. */
  weekdays: number[];
  cronExpression: string;
}

/** docs §17: how a due task behaves while its previous run is still in flight. */
export type ConflictPolicy = 'skip' | 'queue' | 'replace';

export type RunStatus = 'running' | 'success' | 'error' | 'skipped';
export type RunTrigger = 'schedule' | 'manual';

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  status: RunStatus;
  trigger: RunTrigger;
  scheduledFor: string | null;
  startedAt: string;
  /**
   * When the runner actually started the agent (section 14), ISO-8601 UTC.
   * null while the run is still in the script gate; it stays null for a run
   * that will be skipped. Only a started agent counts as "running".
   */
  agentStartedAt: string | null;
  finishedAt: string | null;
  sessionId: string | null;
  output: string | null;
  error: string | null;
  /** Exit code of the script gate, when one ran (section 7). */
  scriptExitCode: number | null;
  /** Truncated stdout of the script gate, when one ran. */
  scriptOutput: string | null;
  /** Effective prompt handed to the agent (static prompt or the script's). */
  promptUsed: string | null;
  /** Resolved parameter values recorded for this run (section 12.4). */
  params?: Record<string, string | number | boolean> | null;
}

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  projectPath: string;
  provider: string;
  model: string | null;
  /** Optional shell command run before the agent (script gate, section 7). */
  command: string | null;
  /** Script gate timeout in seconds (1..3600), null when no command is set. */
  commandTimeoutSeconds: number | null;
  kind: RuleKind;
  rule: RulePayload;
  /** Declared parameters; empty or absent means the task has none (section 12). */
  params?: ParamDef[] | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: RunStatus | null;
  lastError: string | null;
  enabled: boolean;
  /** docs §17: conflict policy while a run is still in flight; legacy rows read 'skip'. */
  conflictPolicy: ConflictPolicy;
  /** docs §19: grouping tags; legacy rows read []. */
  tags?: string[];
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

/** UI filter; mapped to the API's `active`/`paused`/`all` values. */
export type TaskStatusFilter = 'all' | 'enabled' | 'paused';

export interface ScheduledTaskInput {
  title: string;
  prompt: string;
  projectPath: string;
  provider: string;
  model: string | null;
  command: string | null;
  commandTimeoutSeconds: number | null;
  rule: TaskRule;
  /** Always sent: an empty list clears the task's parameters. */
  params?: ParamDef[];
  /** docs §17; defaults to 'skip'. */
  conflictPolicy?: ConflictPolicy;
  /** docs §19; an empty list clears the tags. */
  tags?: string[];
}

export interface ScheduledTaskPatch {
  title?: string;
  prompt?: string;
  projectPath?: string;
  model?: string | null;
  enabled?: boolean;
  rule?: TaskRule;
  /** Explicit null clears the stored command (and its timeout). */
  command?: string | null;
  commandTimeoutSeconds?: number | null;
  /** Replacement parameter list; an empty list removes every parameter. */
  params?: ParamDef[];
  /** docs §17 conflict policy. */
  conflictPolicy?: ConflictPolicy;
  /** docs §19 tags. */
  tags?: string[];
}

export interface ProjectOption {
  value: string;
  label: string;
}

/** Presets (section 10): builtin catalog rows vs user-created bundles. */
export type PresetSource = 'builtin' | 'custom';

/**
 * One task template inside a preset. Mirrors the frozen `PresetTask` shape in
 * docs/scheduled-tasks.md section 10.3 (camelCase, rule already parsed).
 */
export interface PresetTask {
  id: string;
  presetId: string;
  title: string;
  description: string | null;
  prompt: string;
  provider: string;
  model: string | null;
  kind: RuleKind;
  rule: RulePayload;
  command: string | null;
  commandTimeoutSeconds: number | null;
  /** Template parameters, copied into the task on install (section 12.4). */
  params?: ParamDef[] | null;
  position: number;
}

export interface Preset {
  id: string;
  source: PresetSource;
  name: string;
  description: string | null;
  icon: string | null;
  version: string | null;
  /** Whole-preset switch; stored even before the preset is installed. */
  enabled: boolean;
  /** Owning project for custom presets; null for builtin presets. */
  projectPath: string | null;
  taskCount: number;
  /** Distinct project paths of the real tasks this preset installed. */
  installedProjects: string[];
  tasks: PresetTask[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomPresetInput {
  name: string;
  description?: string;
  projectPath: string;
  /** Existing task ids of `projectPath`; order becomes the template order. */
  taskIds: string[];
}

export interface PresetPatch {
  name?: string;
  description?: string;
  icon?: string;
}

/** Result of POST /presets/:id/install (section 10.3). */
export interface InstallPresetResult {
  preset: Preset;
  tasks: ScheduledTask[];
  created: string[];
  updated: string[];
  /** Template ids whose rule has no upcoming run; never a hard failure. */
  skipped: string[];
}

/** Result of POST /presets/:id/enable and /disable. */
export interface PresetEnabledResult {
  preset: Preset;
  tasks: ScheduledTask[];
}

/** Result of DELETE /presets/:id. */
export interface DeletePresetResult {
  id: string;
  deleted: boolean;
  removedTasks: number;
}
/** Payload of POST /:id/copy (section 15). */
export interface CopyTaskInput {
  title?: string;
  /** Target project; defaults to the source task's project. */
  projectPath?: string;
  /** Created paused unless true. */
  enabled?: boolean;
}

/** Portable task definition inside an export envelope (section 16). */
export interface TaskExportPayload {
  title: string;
  prompt: string;
  projectPath?: string;
  provider?: string;
  model?: string | null;
  command?: string | null;
  commandTimeoutSeconds?: number | null;
  params?: ParamDef[];
  rule: RulePayload;
}

/** GET /:id/export response (section 16). */
export interface TaskExport {
  format: string;
  version: number;
  exportedAt: string;
  task: TaskExportPayload;
}

/** Arguments of POST /import (section 16). */
export interface ImportTaskInput {
  task: TaskExportPayload;
  /** Target project; defaults to the envelope's projectPath. */
  projectPath?: string;
  enabled?: boolean;
}

/** One project upgraded by POST /presets/:id/upgrade (section 16). */
export interface PresetUpgradeProject {
  projectPath: string;
  created: string[];
  updated: string[];
  skipped: string[];
}

/** POST /presets/:id/upgrade response (section 16). */
export interface PresetUpgradeResult {
  preset: Preset;
  tasks: ScheduledTask[];
  projects: PresetUpgradeProject[];
}

/** POST /:id/preview response (section 20): the script-gate decision only. */
export interface TaskPreview {
  decision: 'run' | 'skip' | 'error';
  /** The prompt the agent would receive (decision 'run' with a gate). */
  effectivePrompt?: string | null;
  /** Skip reason when decision is 'skip'. */
  reason?: string | null;
  /** Error code when decision is 'error'. */
  error?: string | null;
  /** Whether a script gate actually ran. */
  gate?: boolean;
  scriptExitCode?: number | null;
  scriptOutput?: string | null;
}

/** One upcoming occurrence from GET /upcoming (section 21). */
export interface UpcomingOccurrence {
  taskId: string;
  title: string;
  projectPath: string | null;
  tags?: string[];
  at: string;
}

