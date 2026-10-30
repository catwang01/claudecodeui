/**
 * Shared types for the scheduled-tasks feature.
 *
 * Mirrors the frozen REST contract in docs/scheduled-tasks.md (section 5).
 */

export type RuleKind = 'once' | 'interval' | 'daily' | 'weekly' | 'cron';

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

export type RunStatus = 'running' | 'success' | 'error' | 'skipped';
export type RunTrigger = 'schedule' | 'manual';

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  status: RunStatus;
  trigger: RunTrigger;
  scheduledFor: string | null;
  startedAt: string;
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
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: RunStatus | null;
  lastError: string | null;
  enabled: boolean;
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
}

export interface ProjectOption {
  value: string;
  label: string;
}
