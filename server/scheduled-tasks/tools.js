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
];

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

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

/**
 * @param {object} [options]
 * @param {string|null} [options.projectPath] calling session cwd (default target project)
 * @param {object} [options.management] pre-built management layer (tests)
 * @param {object} [options.deps] deps forwarded to createManagement (tests)
 * @returns {Array} SDK MCP tool definitions
 */
export function createScheduleTools(options = {}) {
  const projectPath = options.projectPath ?? null;
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
      rule: selector.rule,
      userId: null,
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

    if (patch.title === undefined && patch.prompt === undefined && !patch.rule) {
      return {
        ok: false,
        code: 'invalid_input',
        message: 'Nothing to update: provide title, prompt or one selector',
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
    const result = await management.runTaskNow(args.id, scope);
    if (!result.ok) return result;
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

  return [
    tool(
      'schedule_create',
      'Create a scheduled task that starts a new agent run in this project. Provide exactly one schedule selector (after_seconds, at, every_seconds, daily, weekly or cron).',
      {
        prompt: z.string().describe('Prompt sent to the agent when the task runs.'),
        title: z.string().describe('Short human-readable title.'),
        project_path: z
          .string()
          .describe('Target project path; defaults to the current session project.')
          .optional(),
        ...selectorFields,
      },
      create,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_list',
      'List scheduled tasks for this project (active only unless include_paused is true).',
      { include_paused: z.boolean().describe('Include paused tasks. Defaults to false.').optional() },
      list,
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      'schedule_get',
      'Get one scheduled task with its five most recent runs.',
      { id: z.string().describe('Scheduled task id.') },
      get,
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      'schedule_update',
      'Update a scheduled task title, prompt and/or its schedule (at most one selector).',
      {
        id: z.string().describe('Scheduled task id.'),
        title: z.string().optional(),
        prompt: z.string().optional(),
        ...selectorFields,
      },
      update,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_delete',
      'Delete a scheduled task and its run history.',
      { id: z.string().describe('Scheduled task id.') },
      remove,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_run',
      'Start a scheduled task immediately (manual trigger).',
      { id: z.string().describe('Scheduled task id.') },
      run,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_pause',
      'Pause a scheduled task so it stops being due until resumed.',
      { id: z.string().describe('Scheduled task id.') },
      pause,
      { annotations: { readOnlyHint: false } }
    ),
    tool(
      'schedule_resume',
      'Resume a paused scheduled task and recompute its next run.',
      { id: z.string().describe('Scheduled task id.') },
      resume,
      { annotations: { readOnlyHint: false } }
    ),
  ];
}
