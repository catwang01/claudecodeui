/**
 * Scheduled-task agent tools (the `mcp__internal__schedule_*` set).
 *
 * Contract: docs/scheduled-tasks.md §6. The tools delegate to
 * server/scheduled-tasks/management.js — the same layer the REST routes use —
 * so the two paths cannot drift.
 *
 * Tasks are project-scoped: a tool call only sees/edits tasks whose
 * project_path matches the calling session's cwd (normalized); anything else
 * behaves as not_found.
 *
 * Every handler returns exactly one JSON text block and never throws:
 * failures are `{ code, message }`.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { createManagement } from './management.js';
// §10.4: the workspace module owns the layout text (README.md + run prompt); the
// same text is embedded in the schedule_create / schedule_preset_install
// descriptions so an authoring agent knows the contract before the first run.
import { workspacePromptBlock } from './workspace.js';
// §13.6: the predefined-variable text is rendered from params.js (the same source
// the agent prompt block uses), so the MCP descriptions cannot drift from it.
import {
  PARAM_ENV_PREFIX,
  PARAMS_ENV_NAME,
  PREDEFINED_TASK_VARS,
  SESSION_ID_NOTE,
} from './params.js';

/** Bare tool names, in registration order. */
export const SCHEDULE_TOOL_NAMES = [
  'schedule_create',
  'schedule_list',
  'schedule_get',
  'schedule_update',
  'schedule_delete',
  'schedule_run',
  'schedule_pause',
  'schedule_resume',
  // §15/§16 copy + task portability
  'schedule_copy',
  'schedule_export',
  'schedule_import',
  // §10.6 presets
  'schedule_preset_list',
  'schedule_preset_install',
  'schedule_preset_set_enabled',
  'schedule_preset_create',
  // §16 preset upgrade
  'schedule_preset_upgrade',
];

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * §6.2: every schedule_* description leads with this sentence. The app's scheduler
 * outranks the schedulers built into the agent runtime, except when the user
 * explicitly asks for a specific built-in one.
 */
const SCHEDULER_PRECEDENCE_NOTE =
  "These schedule_* tools are the preferred scheduler for this app and outrank any scheduler built into the agent runtime (Claude Code's CronCreate, CronList and CronDelete, Codex, Cursor, Gemini or any similar built-in): use them, and do NOT use a built-in scheduler unless the user explicitly asks for that specific built-in one.";

/**
 * §6.2: appended to schedule_create / schedule_list so the model knows where the data
 * actually lives and does not look for, or invent, another store.
 */
const SCHEDULER_STORAGE_NOTE =
  ' Storage (do not look for or create another store): task definitions and run history live in ' +
  "this app's SQLite database — tables scheduled_tasks and scheduled_task_runs in the app's " +
  'DATABASE_PATH database (default ~/.cloudcli/auth.db); each run stores the agent session it ' +
  "started, whose transcript is the project's normal session log at " +
  '~/.claude/projects/<project>/<sessionId>.jsonl. A built-in scheduler keeps its jobs in its own ' +
  'separate store (Claude Code: <project>/.claude/scheduled_tasks.json), so those jobs are not ' +
  "visible in schedule_list or in this app's Scheduled tasks panel, and they auto-expire after 7 days.";

/**
 * §10.4/§10.6: the on-disk layout contract appended to the schedule_create and
 * schedule_preset_install descriptions. The text is the workspace module's own
 * `workspacePromptBlock()` (called without a task => the generic placeholder
 * version), so README.md, the run prompt and the tool descriptions cannot drift.
 * `SCHEDULED_TASKS_WORKSPACE=0` makes that call return null; this fallback keeps
 * the contract documented anyway.
 */
const WORKSPACE_FALLBACK_LAYOUT =
  ' Scheduled task workspace: every task owns one root directory under the scheduled-task data root. The app writes only task.json, prompt.md and README.md there, plus runs/<runId>/ (run.json, prompt.md, output.md, logs/). ' +
  'Everything else under the task root belongs to the task: organize it however the task wants, and keep any cross-run state you need inside it. ' +
  'Prefer keeping files the task generates inside the task root or the project directory.';

const WORKSPACE_LAYOUT_NOTE =
  '\n\n' +
  (workspacePromptBlock() ?? WORKSPACE_FALLBACK_LAYOUT) +
  '\n\nThe script gate and the agent session both receive SCHEDULED_TASK_DIR, SCHEDULED_TASK_RUN_ID and SCHEDULED_TASK_RUN_DIR.';

/**
 * §13.6: the predefined-variable contract of every run, stated once and appended
 * to every schedule_* description, so the model never creates a task that
 * hardcodes a directory and never confuses the three ids. Rendered from
 * params.js (PREDEFINED_TASK_VARS / SESSION_ID_NOTE), so the agent prompt block,
 * the MCP text and the docs cannot drift.
 */
const PREDEFINED_VARS_NOTE =
  ' Predefined variables every run injects into the script gate environment AND the agent session environment, with the same names and values: ' +
  PREDEFINED_TASK_VARS.map((entry) => entry.envName + ' (' + entry.description + ')').join('; ') +
  '; plus the user-declared parameters ' +
  PARAM_ENV_PREFIX +
  '<NAME> and the compact JSON ' +
  PARAMS_ENV_NAME +
  '. The task root (SCHEDULED_TASK_DIR) belongs to the task: the app writes only task.json, prompt.md, README.md and runs/<runId>/ there, so keep any cross-run state you need inside that root, in whatever layout you choose. ' +
  'Read these from the environment; never hardcode the task name, the project path or any workspace directory, so the task keeps working from any directory. ' +
  SESSION_ID_NOTE;

/** SCHEDULED_TASKS_TOOLS=0 (default on) removes the tools entirely. */
export function isScheduleToolsEnabled() {
  const raw = process.env.SCHEDULED_TASKS_TOOLS;
  if (raw === undefined || raw === '') return true;
  return !DISABLED_VALUES.has(String(raw).toLowerCase());
}

function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

function jsonContent(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Wrap a handler so it never throws and always returns one JSON text block.
 * Expected failures come back as { ok:false, code, message }; anything else is
 * reported as internal_error.
 */
function guarded(name, fn) {
  return async (args) => {
    try {
      const result = await fn(args ?? {});
      if (result && result.ok === false) {
        return jsonContent({ code: result.code, message: result.message });
      }
      return jsonContent(result);
    } catch (err) {
      return jsonContent({
        code: 'internal_error',
        message: `${name} failed: ${errorMessage(err)}`,
      });
    }
  };
}

const selectorFields = {
  after_seconds: z.number().describe('Run once, this many seconds from now.').optional(),
  at: z.string().describe('Run once at an ISO-8601 timestamp with an explicit UTC offset.').optional(),
  every_seconds: z.number().describe('Repeat every N seconds (minimum 60).').optional(),
  daily: z
    .object({ time: z.string().describe('HH:mm or HH:mm:ss'), time_zone: z.string().describe('IANA time zone') })
    .describe('Run every day at a local wall-clock time.')
    .optional(),
  weekly: z
    .object({
      time: z.string(),
      time_zone: z.string(),
      weekdays: z.array(z.number()).describe('ISO weekdays, Monday=1 .. Sunday=7'),
    })
    .describe('Run on selected weekdays at a local wall-clock time.')
    .optional(),
  cron: z
    .object({ expression: z.string().describe('Vixie 5-field cron expression'), time_zone: z.string() })
    .describe('Run on a cron schedule.')
    .optional(),
};

// §12 parameters: named, typed, optionally-defaulted values that are resolved per
// run and exported to the script gate and the agent environment.
const paramDefFields = z.object({
  name: z.string().describe('Parameter name: ^[A-Za-z_][A-Za-z0-9_]{0,63}$, unique case-insensitively.'),
  type: z.enum(['string', 'number', 'boolean']).describe("Parameter type. Defaults to 'string'.").optional(),
  default: z
    .union([z.string(), z.number(), z.boolean()])
    .describe('Default value, coerced to the declared type.')
    .optional(),
  description: z.string().describe('Short human-readable description (at most 500 characters).').optional(),
  required: z
    .boolean()
    .describe('Without a default, the run fails when no value is supplied. Defaults to false.')
    .optional(),
});

const paramsField = z
  .array(paramDefFields)
  .describe(
    'Parameter definitions (at most 32, names unique case-insensitively). At run time they are exported to the script gate and the agent as SCHEDULED_TASK_PARAM_<NAME> plus the compact JSON SCHEDULED_TASK_PARAMS. Independent of these, every run also exports the built-in SCHEDULED_TASK_TITLE, SCHEDULED_TASK_CWD and SCHEDULED_TASK_PROJECT.'
  )
  .optional();

const paramsNullableField = z
  .union([z.array(paramDefFields), z.null()])
  .describe('Replace the parameter definitions; pass null to remove every parameter.')
  .optional();

const paramOverridesField = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe(
    'Per-run parameter overrides keyed by parameter name (docs §12.3); they win over the task defaults. Unknown names or uncoercible values are invalid_input.'
  )
  .optional();

// §7 script gate. The command must print a JSON envelope on stdout so a
// "nothing to do" check never reaches the model.
const gateFields = {
  command: z
    .string()
    .nullable()
    .describe(
      'Optional shell command executed with sh -c in the project before the agent runs. ' +
        'Its stdout must be a JSON envelope: {"skip":true,"reason":"..."} skips the run (no agent call, run status skipped); ' +
        '{"prompt":"<text>"} runs the agent with that prompt; {"skip":false} runs it with the task prompt. ' +
        'A non-zero exit, a timeout, unparsable output or an unknown shape fails the run without calling the agent. ' +
        'Pass null to clear an existing command.'
    )
    .optional(),
  command_timeout_seconds: z
    .number()
    .nullable()
    .describe('Seconds allowed for the command (default 60, allowed 1..3600). Pass null to reset to the default.')
    .optional(),
};

/** §17 conflict policy: what to do when a task is due during its previous run. */
const conflictPolicyField = z
  .enum(['skip', 'queue', 'replace'])
  .describe(
    "What happens when the task is due while its previous run is still running. 'skip' (default) leaves that occurrence unrun; 'queue' runs it once the current run finishes (newest queued trigger wins); 'replace' aborts the current run's agent and starts this one."
  );

/**
 * @param {object} [options]
 * @param {string|null} [options.projectPath] calling session cwd (default target project)
 * @param {object} [options.management] pre-built management layer (tests)
 * @param {object} [options.deps] deps forwarded to createManagement (tests)
 * @returns {Array} SDK MCP tool definitions
 */
export function createScheduleTools(options = {}) {
  const projectPath = options.projectPath ?? null;
  // Session owner, when the caller knows it; keeps agent-created tasks attributed
  // to the logged-in user instead of leaving user_id NULL (docs §6).
  const userId = options.userId ?? null;
  const scope = projectPath ? { projectPath } : {};
  const management = options.management ?? createManagement(options.deps ?? {});

  const create = guarded('schedule_create', async (args) => {
    const selector = management.ruleFromArgs(args, { required: true });
    if (!selector.ok) return selector;
    const result = await management.createTask({
      title: args.title,
      prompt: args.prompt,
      projectPath: args.project_path || projectPath,
      provider: 'claude',
      command: args.command,
      commandTimeoutSeconds: args.command_timeout_seconds,
      params: args.params,
      conflictPolicy: args.conflict_policy,
      rule: selector.rule,
      userId,
    });
    // The tool returns the bare task view (docs §6).
    return result.ok ? result.task : result;
  });

  const list = guarded('schedule_list', async (args) => {
    const result = await management.listTasks(
      { userId: null, status: args.include_paused ? 'all' : 'active' },
      scope
    );
    return { tasks: result.tasks };
  });

  const get = guarded('schedule_get', async (args) => {
    const result = await management.getTaskWithRuns(args.id, scope, 5);
    if (!result.ok) return result;
    return { task: result.task, recent_runs: result.recent_runs };
  });

  const update = guarded('schedule_update', async (args) => {
    const patch = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.prompt !== undefined) patch.prompt = args.prompt;

    const selector = management.ruleFromArgs(args, { required: false });
    if (!selector.ok) return selector;
    if (selector.rule) patch.rule = selector.rule;

    if (args.command !== undefined) patch.command = args.command;
    if (args.command_timeout_seconds !== undefined) {
      patch.commandTimeoutSeconds = args.command_timeout_seconds;
    }
    if (args.params !== undefined) patch.params = args.params;
    if (args.conflict_policy !== undefined) patch.conflictPolicy = args.conflict_policy;

    if (
      patch.title === undefined &&
      patch.prompt === undefined &&
      patch.command === undefined &&
      patch.commandTimeoutSeconds === undefined &&
      patch.params === undefined &&
      patch.conflictPolicy === undefined &&
      !patch.rule
    ) {
      return {
        ok: false,
        code: 'invalid_input',
        message:
          'Nothing to update: provide title, prompt, params, conflict policy, command, command timeout or one selector',
      };
    }
    const result = await management.updateTask(args.id, patch, scope);
    return result.ok ? result.task : result;
  });

  const remove = guarded('schedule_delete', async (args) => {
    const result = await management.deleteTask(args.id, scope);
    if (!result.ok) return result;
    return { id: result.id, deleted: true };
  });

  const run = guarded('schedule_run', async (args) => {
    const result = await management.runTaskNow(args.id, scope, { params: args.params });
    if (!result.ok) return result;
    if (result.queued) return { queued: true };
    return { run: result.run };
  });

  const pause = guarded('schedule_pause', async (args) => {
    const result = await management.pauseTask(args.id, scope);
    return result.ok ? result.task : result;
  });

  const resume = guarded('schedule_resume', async (args) => {
    const result = await management.resumeTask(args.id, scope);
    return result.ok ? result.task : result;
  });

  // ─── Copy / portability (§15, §16) ───────────────────────────────────────────

  const copy = guarded('schedule_copy', async (args) => {
    const result = await management.copyTask(
      args.id,
      {
        title: args.title,
        projectPath: args.project_path,
        enabled: args.enabled,
        userId,
      },
      scope
    );
    return result.ok ? result.task : result;
  });

  const exportTask = guarded('schedule_export', async (args) => {
    const result = await management.exportTask(args.id, scope);
    if (!result.ok) return result;
    return {
      format: result.format,
      version: result.version,
      exportedAt: result.exportedAt,
      task: result.task,
    };
  });

  const importTask = guarded('schedule_import', async (args) => {
    const result = await management.importTask(
      {
        task: args.task,
        projectPath: args.project_path || projectPath,
        enabled: args.enabled,
        userId,
      },
      scope
    );
    return result.ok ? result.task : result;
  });

  // ─── Presets (§10.6) ─────────────────────────────────────────────────────────

  const presetList = guarded('schedule_preset_list', async (args) => {
    const result = await management.presets.listPresets({ projectPath: projectPath ?? null });
    if (!result.ok) return result;
    const presets =
      args.include_catalog === false
        ? result.presets.filter((preset) => preset.source !== 'builtin')
        : result.presets;
    return { presets };
  });

  const presetInstall = guarded('schedule_preset_install', async (args) => {
    const result = await management.presets.installPreset(args.id, {
      projectPath: args.project_path || projectPath,
      enabled: args.enabled,
      params: args.params,
      userId,
    });
    if (!result.ok) return result;
    return {
      preset: result.preset,
      tasks: result.tasks,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
    };
  });

  const presetSetEnabled = guarded('schedule_preset_set_enabled', async (args) => {
    const result = await management.presets.setPresetEnabled(args.id, args.enabled, {
      projectPath: projectPath ?? null,
    });
    if (!result.ok) return result;
    return { preset: result.preset, tasks: result.tasks };
  });

  const presetCreate = guarded('schedule_preset_create', async (args) => {
    let taskIds = Array.isArray(args.task_ids) ? args.task_ids : null;
    if (!taskIds) {
      // Default: every task of the session project (paused ones included).
      const listed = await management.listTasks({ userId: null, status: 'all' }, scope);
      taskIds = (listed.tasks || []).map((task) => task.id);
    }
    const result = await management.presets.createCustomPreset({
      name: args.name,
      description: args.description,
      projectPath,
      taskIds,
      userId,
    });
    if (!result.ok) return result;
    return { preset: result.preset };
  });

  const presetUpgrade = guarded('schedule_preset_upgrade', async (args) => {
    const result = await management.presets.upgradePreset(args.id, {
      projectPath: projectPath ?? null,
      userId,
    });
    if (!result.ok) return result;
    return { preset: result.preset, tasks: result.tasks, projects: result.projects };
  });

  return [
    tool(
      'schedule_create',
      SCHEDULER_PRECEDENCE_NOTE +
        SCHEDULER_STORAGE_NOTE +
        ' Create a scheduled task that starts a new agent run in this project. Provide exactly one schedule selector (after_seconds, at, every_seconds, daily, weekly or cron).' +
        ' Optionally add a script gate via command/command_timeout_seconds: the command runs first and its stdout JSON envelope ({"skip":true,"reason":"..."} | {"prompt":"..."} | {"skip":false}) decides whether the agent runs and with which prompt.' +
        ' Optionally declare params: each run resolves them and exports them to the script gate and the agent as SCHEDULED_TASK_PARAM_<NAME> plus the compact JSON SCHEDULED_TASK_PARAMS.' +
        ' Optionally set conflict_policy (skip | queue | replace) for what happens when the task is due while its previous run is still running; the default skip leaves that occurrence unrun.' +
        PREDEFINED_VARS_NOTE +
        WORKSPACE_LAYOUT_NOTE,
      {
        prompt: z.string().describe('Prompt sent to the agent when the task runs.'),
        title: z.string().describe('Short human-readable title.'),
        project_path: z
          .string()
          .describe('Target project path; defaults to the current session project.')
          .optional(),
        params: paramsField,
        conflict_policy: conflictPolicyField.optional(),
        ...selectorFields,
        ...gateFields,
      },
      create,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_list',
      SCHEDULER_PRECEDENCE_NOTE +
        ' List scheduled tasks for this project (active only unless include_paused is true).' +
        SCHEDULER_STORAGE_NOTE +
        PREDEFINED_VARS_NOTE,
      { include_paused: z.boolean().describe('Include paused tasks. Defaults to false.').optional() },
      list,
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      'schedule_get',
      SCHEDULER_PRECEDENCE_NOTE + ' Get one scheduled task with its five most recent runs.' + PREDEFINED_VARS_NOTE,
      { id: z.string().describe('Scheduled task id.') },
      get,
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      'schedule_update',
      SCHEDULER_PRECEDENCE_NOTE +
        ' Update a scheduled task title, prompt, params, conflict_policy (skip | queue | replace), script gate (command/command_timeout_seconds) and/or its schedule (at most one selector).' +
        ' A command gate runs before the agent and prints a JSON envelope ({"skip":true,"reason":"..."} | {"prompt":"..."} | {"skip":false}); null clears the gate.' +
        ' params replaces the parameter definitions; null removes every parameter.' +
        PREDEFINED_VARS_NOTE,
      {
        id: z.string().describe('Scheduled task id.'),
        title: z.string().optional(),
        prompt: z.string().optional(),
        params: paramsNullableField,
        conflict_policy: conflictPolicyField.optional(),
        ...selectorFields,
        ...gateFields,
      },
      update,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_delete',
      SCHEDULER_PRECEDENCE_NOTE + ' Delete a scheduled task and its run history.' + PREDEFINED_VARS_NOTE,
      { id: z.string().describe('Scheduled task id.') },
      remove,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_run',
      SCHEDULER_PRECEDENCE_NOTE +
        ' Start a scheduled task immediately (manual trigger). Pass params to override the task parameter defaults for this run only (docs §12.3). Under the queue conflict policy an already running task queues this trigger and the reply is {queued:true} instead of a run.' +
        PREDEFINED_VARS_NOTE,
      {
        id: z.string().describe('Scheduled task id.'),
        params: paramOverridesField,
      },
      run,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_pause',
      SCHEDULER_PRECEDENCE_NOTE + ' Pause a scheduled task so it stops being due until resumed.' + PREDEFINED_VARS_NOTE,
      { id: z.string().describe('Scheduled task id.') },
      pause,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_resume',
      SCHEDULER_PRECEDENCE_NOTE + ' Resume a paused scheduled task and recompute its next run.' + PREDEFINED_VARS_NOTE,
      { id: z.string().describe('Scheduled task id.') },
      resume,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_copy',
      SCHEDULER_PRECEDENCE_NOTE +
        ' Duplicate a scheduled task. The copy keeps the prompt, params, script gate and rule but starts with a fresh run history and no preset link; it is created paused unless enabled is true. project_path defaults to the source project, so a task can be copied into another project.' +
        PREDEFINED_VARS_NOTE,
      {
        id: z.string().describe('Scheduled task id to copy.'),
        title: z.string().describe('Optional title for the copy; defaults to "<title> (copy)".').optional(),
        project_path: z
          .string()
          .describe('Target project path; defaults to the source task project.')
          .optional(),
        enabled: z.boolean().describe('Create the copy enabled. Defaults to false (paused).').optional(),
      },
      copy,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_export',
      SCHEDULER_PRECEDENCE_NOTE +
        ' Export one scheduled task as a portable JSON envelope (format, version, task) that schedule_import or another instance can recreate. Run history and ids are not included.' +
        PREDEFINED_VARS_NOTE,
      { id: z.string().describe('Scheduled task id.') },
      exportTask,
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      'schedule_import',
      SCHEDULER_PRECEDENCE_NOTE +
        ' Create a new paused scheduled task from a schedule_export envelope (or a raw task definition). The target project defaults to the session project when the envelope has no projectPath.' +
        PREDEFINED_VARS_NOTE,
      {
        task: z
          .record(z.string(), z.unknown())
          .describe('Exported task object: title, prompt, rule, and optional provider/model/command/commandTimeoutSeconds/params.'),
        project_path: z.string().describe('Target project path; defaults to the session project.').optional(),
        enabled: z.boolean().describe('Create the imported task enabled. Defaults to false (paused).').optional(),
      },
      importTask,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_preset_list',
      SCHEDULER_PRECEDENCE_NOTE +
        ' List installable task presets: the built-in catalog plus the custom presets that belong to this project. Set include_catalog to false to list custom presets only.' +
        PREDEFINED_VARS_NOTE,
      { include_catalog: z.boolean().describe('Include the built-in catalog. Defaults to true.').optional() },
      presetList,
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      'schedule_preset_install',
      SCHEDULER_PRECEDENCE_NOTE +
        ' Install a preset into this project: every task template becomes a real scheduled task linked back to the preset, so enabling or disabling the preset switches them all at once. Installing again is idempotent — linked tasks are updated, never duplicated.' +
        ' Optional params overrides are applied to every installed task whose template declares that parameter name (docs §12.5).' +
        PREDEFINED_VARS_NOTE +
        WORKSPACE_LAYOUT_NOTE,
      {
        id: z.string().describe('Preset id (see schedule_preset_list).'),
        project_path: z
          .string()
          .describe('Target project path; defaults to the current session project.')
          .optional(),
        enabled: z
          .boolean()
          .describe('Install the preset enabled. Defaults to true; pass false to install it paused.')
          .optional(),
        params: paramOverridesField,
      },
      presetInstall,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_preset_set_enabled',
      SCHEDULER_PRECEDENCE_NOTE +
        ' Enable or disable a whole preset: the preset flag flips and every scheduled task it installed follows (enabling recomputes each next run, disabling clears it).' +
        PREDEFINED_VARS_NOTE,
      {
        id: z.string().describe('Preset id.'),
        enabled: z.boolean().describe('true to enable the whole preset, false to disable it.'),
      },
      presetSetEnabled,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_preset_create',
      SCHEDULER_PRECEDENCE_NOTE +
        ' Create a custom preset by snapshotting existing scheduled tasks of this project, so the bundle can be installed and toggled as one unit. task_ids defaults to every task of the session project.' +
        PREDEFINED_VARS_NOTE,
      {
        name: z.string().describe('Human-readable preset name.'),
        description: z.string().describe('Optional preset description.').optional(),
        task_ids: z
          .array(z.string())
          .describe('Scheduled task ids to snapshot, in order. Defaults to every task of the session project.')
          .optional(),
      },
      presetCreate,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_preset_upgrade',
      SCHEDULER_PRECEDENCE_NOTE +
        ' Re-materialize a built-in preset from the current catalog into every project where it is installed, preserving each task\'s enabled flag. Custom presets cannot be upgraded.' +
        PREDEFINED_VARS_NOTE,
      { id: z.string().describe('Built-in preset id.') },
      presetUpgrade,
      { annotations: { readOnlyHint: false } }
    ),
  ];
}
