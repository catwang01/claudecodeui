/**
 * Scheduled task runner.
 *
 * Executes a scheduled task by starting a *new* headless agent session in the
 * task's project. The 'running' run row is created synchronously so API callers
 * can return it immediately; the actual work happens on the microtask queue.
 *
 * Contract: docs/scheduled-tasks.md §4.
 *   startTaskRun(task, { trigger, scheduledFor }) -> { run, done }
 *   done never rejects; failures come back as { status: 'error', ... }.
 *
 * MVP: only provider 'claude' is supported.
 * Timeout: SCHEDULED_TASK_TIMEOUT_MS (default 1800000) then error + best-effort abort.
 * Test seam: SCHEDULED_TASK_DRY_RUN=1 creates the run row and finishes it as
 * 'success' with output '[dry-run] <prompt>' without calling queryClaudeSDK.
 */

import { scheduledTasksDb } from '../modules/database/index.js';
import { addProjectManually } from '../projects.js';
import { queryClaudeSDK, abortClaudeSDKSession } from '../claude-sdk.js';

const DEFAULT_TIMEOUT_MS = 1800000;
const SUPPORTED_PROVIDERS = new Set(['claude']);

class ScheduledTaskTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduledTaskTimeoutError';
    this.isScheduledTaskTimeout = true;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function resolveTimeoutMs(override) {
  if (Number.isFinite(override) && override > 0) return override;
  const raw = parseInt(process.env.SCHEDULED_TASK_TIMEOUT_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function isDryRun() {
  return process.env.SCHEDULED_TASK_DRY_RUN === '1';
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

/**
 * Build a runner bound to a set of collaborators. Dependencies are injectable so
 * tests can run without touching the database or spawning a real agent.
 */
export function createTaskRunner(deps = {}) {
  const db = deps.scheduledTasksDb ?? scheduledTasksDb;
  const ensureProject = deps.addProjectManually ?? addProjectManually;
  const query = deps.queryClaudeSDK ?? queryClaudeSDK;
  const abortSession = deps.abortClaudeSDKSession ?? abortClaudeSDKSession;
  const timeoutOverride = deps.timeoutMs;

  function finishOnce(run, status, extra = {}) {
    const output = extra.output !== undefined ? extra.output : null;
    const sessionId = extra.sessionId !== undefined ? extra.sessionId : null;
    const error = extra.error !== undefined ? extra.error : null;
    let finished = run;
    try {
      const updated = db.finishRun(run.id, {
        status,
        finishedAt: nowIso(),
        sessionId: sessionId ?? null,
        output,
        error,
      });
      if (updated) finished = updated;
    } catch (err) {
      console.error('[scheduled-tasks] finishRun failed:', errorMessage(err));
    }
    return { run: finished, status, sessionId: sessionId ?? null, output, error };
  }

  async function execute(task, run) {
    // Rows are snake_case (docs §3); accept camelCase too for callers that map first.
    const projectPath = task.project_path ?? task.projectPath ?? null;
    let sessionId = null;
    let errorText = null;
    const chunks = [];

    const collectedOutput = () => (chunks.length ? chunks.join('\n') : null);

    if (!SUPPORTED_PROVIDERS.has(task.provider ?? 'claude')) {
      return finishOnce(run, 'error', { error: `Unsupported provider: ${task.provider}` });
    }

    // Dry-run: exercise schedule -> fire -> run -> advance without a model call.
    if (isDryRun()) {
      return finishOnce(run, 'success', {
        output: `[dry-run] ${task.prompt}`,
        sessionId: null,
      });
    }

    // Best-effort: make sure the project is registered so the run shows up in the UI.
    // addProjectManually throws when the path is already configured, which is fine.
    try {
      await ensureProject(projectPath);
    } catch (err) {
      console.warn(
        `[scheduled-tasks] addProjectManually(${projectPath}) skipped: ${errorMessage(err)}`
      );
    }

    const writer = {
      userId: task.user_id ?? task.userId ?? null,
      send(message) {
        if (!message || typeof message !== 'object') return;
        switch (message.kind) {
          case 'session_created': {
            const id = message.sessionId ?? message.newSessionId ?? null;
            if (id) sessionId = id;
            break;
          }
          case 'text': {
            if (message.role === 'user') break;
            if (typeof message.content === 'string' && message.content) chunks.push(message.content);
            break;
          }
          case 'error': {
            if (typeof message.content === 'string' && message.content) errorText = message.content;
            break;
          }
          default:
            break;
        }
      },
    };

    // Unattended runs have no browser to answer permission prompts, so approvals
    // must be bypassed — same as the external API route (server/routes/agent.js).
    const options = { cwd: projectPath, permissionMode: 'bypassPermissions' };
    if (task.model) options.model = task.model;

    const timeoutMs = resolveTimeoutMs(timeoutOverride);
    let timer = null;
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ScheduledTaskTimeoutError(`Scheduled task timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });

    try {
      await Promise.race([query(task.prompt, options, writer), timedOut]);
    } catch (err) {
      if (err && err.isScheduledTaskTimeout) {
        // Best-effort abort: the session may already be gone by now.
        if (sessionId) {
          try {
            await abortSession(sessionId);
          } catch (abortErr) {
            console.warn(
              `[scheduled-tasks] abort(${sessionId}) failed: ${errorMessage(abortErr)}`
            );
          }
        }
        return finishOnce(run, 'error', { error: errorMessage(err), sessionId, output: collectedOutput() });
      }
      return finishOnce(run, 'error', { error: errorMessage(err), sessionId, output: collectedOutput() });
    } finally {
      if (timer) clearTimeout(timer);
    }

    // The SDK can surface a failed turn as an 'error' message without throwing.
    if (errorText) {
      return finishOnce(run, 'error', { error: errorText, sessionId, output: collectedOutput() });
    }

    return finishOnce(run, 'success', { sessionId, output: collectedOutput() });
  }

  function startTaskRun(task, { trigger = 'schedule', scheduledFor = null } = {}) {
    const run = db.createRun({
      taskId: task.id,
      status: 'running',
      trigger,
      scheduledFor,
      startedAt: nowIso(),
    });

    const done = execute(task, run).catch((err) => {
      // execute() only throws on unexpected internal faults (e.g. the DB layer).
      return finishOnce(run, 'error', { error: errorMessage(err) });
    });

    return { run, done };
  }

  return { startTaskRun };
}

const defaultRunner = createTaskRunner();

/**
 * @param {object} task scheduled task row
 * @param {{ trigger?: 'schedule'|'manual', scheduledFor?: string|null }} [options]
 * @returns {{ run: object, done: Promise<{ run: object, status: string, sessionId: string|null, output: string|null, error: string|null }> }}
 */
export function startTaskRun(task, options = {}) {
  return defaultRunner.startTaskRun(task, options);
}
