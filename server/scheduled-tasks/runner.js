/**
 * Scheduled task runner.
 *
 * Executes a scheduled task by starting a *new* headless agent session in the
 * task's project. The 'running' run row is created synchronously so API callers
 * can return it immediately; the actual work happens on the microtask queue.
 *
 * Contract: docs/scheduled-tasks.md §4 and §7.
 *   startTaskRun(task, { trigger, scheduledFor }) -> { run, done }
 *   done never rejects; failures come back as { status: 'error', ... }.
 *
 * Script gate (§7): when the task has a 'command', it runs first with 'sh -c' in
 * the project directory. Its stdout is a JSON envelope that either skips the run
 * (status 'skipped', no agent call), overrides the prompt, or falls back to the
 * task prompt. Gate errors (script_exit_<code> / script_failed / script_timeout /
 * invalid_script_output / commands_disabled) fail the run without an agent call.
 *
 * MVP: only provider 'claude' is supported.
 * Timeout: SCHEDULED_TASK_TIMEOUT_MS (default 1800000) then error + best-effort abort.
 * Test seam: SCHEDULED_TASK_DRY_RUN=1 runs everything up to (and including) the gate,
 * then replaces only the agent call with output '[dry-run] <effective prompt>' and
 * promptUsed = <effective prompt>.
 *
 * Workspace (§10.4): every run plans its on-disk workspace through
 * ./workspace.js — the task root (task.json/README.md/prompt.md) and this run's
 * directory (run.json/prompt.md/output.md/logs) exist before the script gate, the
 * gate and the agent both receive SCHEDULED_TASK_DIR / RUN_ID / RUN_DIR, the agent
 * prompt is prefixed with workspacePromptBlock(...) while promptUsed stays the
 * effective prompt, and finishOnce records output.md/run.json through
 * finalizeRunWorkspace. The rest of the task root belongs to the task.
 * SCHEDULED_TASKS_WORKSPACE=0 disables the whole layer.
 *
 * Parameters (§12): the task's ParamDef[] is resolved before the script gate into
 * a typed value map, exported to the gate (SCHEDULED_TASK_PARAM_* /
 * SCHEDULED_TASK_PARAMS), handed to the agent via options.env, and written to the
 * run row (params_json) and runs/<runId>/run.json (params).
 *
 * Predefined variables (§13): every run exports SCHEDULED_TASK_ID, TITLE, CWD,
 * PROJECT, DIR, RUN_ID and RUN_DIR plus the §12 parameters to the script gate AND
 * to the agent (options.env), from one predefinedVarsEnv() object, so both paths
 * always agree. A static "Predefined scheduled-task variables" block is prepended
 * to the prompt, so a task never has to hardcode its project directory.
 *
 * Running count (§14.2): agent_started_at is written immediately before the agent
 * call (and in the dry-run branch that stands in for it). The script gate, a
 * skip, a gate/params error and an unsupported provider all leave it NULL, so
 * "script is running" is never reported as "task is running".
 */

import { spawn as nodeSpawn } from 'child_process';
import { scheduledTasksDb } from '../modules/database/index.js';
import { addProjectManually } from '../projects.js';
import { queryClaudeSDK, abortClaudeSDKSession } from '../claude-sdk.js';
import {
  ensureRunWorkspace,
  ensureTaskWorkspace,
  finalizeRunWorkspace,
  workspaceEnv,
  workspacePromptBlock,
} from './workspace.js';
// §12/§13: the parameter layer is pure; the runner only resolves and exports it.
import {
  parseParamDefs,
  paramsPromptBlock,
  predefinedVarsEnv,
  predefinedVarsPromptBlock,
  resolveParams,
} from './params.js';

const DEFAULT_TIMEOUT_MS = 1800000;
const SUPPORTED_PROVIDERS = new Set(['claude']);
const SCRIPT_OUTPUT_LIMIT = 20000;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 60;
const MAX_COMMAND_TIMEOUT_SECONDS = 3600;
const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

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

/** §12.4: the task's ParamDef[] (row or view shape); unreadable JSON reads as []. */
function taskParamDefs(task) {
  if (!task || typeof task !== 'object') return [];
  return parseParamDefs(task.params_json ?? task.paramsJson ?? task.params);
}

/** SCHEDULED_TASKS_COMMANDS=0 disables the script gate (commands_disabled). */
function commandsEnabled() {
  const raw = process.env.SCHEDULED_TASKS_COMMANDS;
  if (raw === undefined || raw === '') return true;
  return !DISABLED_VALUES.has(String(raw).toLowerCase());
}

function resolveCommandTimeoutSeconds(task) {
  const raw = task.command_timeout_seconds ?? task.commandTimeoutSeconds;
  const parsed = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_COMMAND_TIMEOUT_SECONDS;
  return Math.min(Math.trunc(parsed), MAX_COMMAND_TIMEOUT_SECONDS);
}

function truncateScriptOutput(text) {
  if (typeof text !== 'string') return null;
  return text.length > SCRIPT_OUTPUT_LIMIT ? text.slice(0, SCRIPT_OUTPUT_LIMIT) : text;
}

function tryParseEnvelopeObject(text) {
  if (!text) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  // Arrays and primitives are not envelopes (§7 step 5).
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

/** JSON.parse(stdout.trim()), else the last non-empty line (§7 step 5). */
function parseEnvelope(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const fromWhole = tryParseEnvelopeObject(text.trim());
  if (fromWhole) return { ok: true, value: fromWhole };

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseEnvelopeObject(lines[index]);
    if (parsed) return { ok: true, value: parsed };
  }
  return { ok: false };
}

/** Envelope -> { skip } | { prompt } decision (§7 step 6). */
function decideEnvelope(envelope, taskPrompt) {
  if (envelope.skip === true) {
    return {
      ok: true,
      skip: true,
      reason: typeof envelope.reason === 'string' && envelope.reason ? envelope.reason : null,
      prompt: null,
    };
  }
  if (typeof envelope.prompt === 'string' && envelope.prompt.trim()) {
    return { ok: true, skip: false, reason: null, prompt: envelope.prompt };
  }
  if (envelope.skip === false) {
    return { ok: true, skip: false, reason: null, prompt: taskPrompt };
  }
  return { ok: false };
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
  const spawnImpl = deps.spawn ?? nodeSpawn;
  const timeoutOverride = deps.timeoutMs;

  function finishOnce(task, run, status, extra = {}) {
    const output = extra.output !== undefined ? extra.output : null;
    const sessionId = extra.sessionId !== undefined ? extra.sessionId : null;
    const error = extra.error !== undefined ? extra.error : null;
    const scriptExitCode = extra.scriptExitCode !== undefined ? extra.scriptExitCode : null;
    const scriptOutput = extra.scriptOutput !== undefined ? extra.scriptOutput : null;
    const promptUsed = extra.promptUsed !== undefined ? extra.promptUsed : null;
    let finished = run;
    try {
      const updated = db.finishRun(run.id, {
        status,
        finishedAt: nowIso(),
        sessionId: sessionId ?? null,
        output,
        error,
        scriptExitCode,
        scriptOutput,
        promptUsed,
      });
      if (updated) finished = updated;
    } catch (err) {
      console.error('[scheduled-tasks] finishRun failed:', errorMessage(err));
    }

    // §10.4 step 4: record the outcome on disk (best-effort, never throws).
    finalizeRunWorkspace(task, run, { status, output, error, sessionId, scriptExitCode, scriptOutput });

    return {
      run: finished,
      status,
      sessionId: sessionId ?? null,
      output,
      error,
      scriptExitCode,
      scriptOutput,
      promptUsed,
    };
  }

  /**
   * §7: run the task's command with 'sh -c' in projectPath, capture stdout and the
   * exit code, and turn the JSON envelope into a skip/prompt decision.
   * Never rejects.
   */
  function runScriptGate(task, projectPath, predefinedVars, paramVars) {
    const command = task.command;
    const timeoutSeconds = resolveCommandTimeoutSeconds(task);
    const env = {
      ...process.env,
      // §13.3: the predefined variables come first (the same object the agent
      // env is built from); the parameters (§12.2) are merged after them and can
      // never collide with a predefined name, because their namespaces are
      // disjoint (§13.2).
      ...(predefinedVars ?? {}),
      ...(paramVars ?? {}),
    };

    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl('sh', ['-c', command], {
          cwd: projectPath || process.cwd(),
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        resolve({ ok: false, code: 'script_failed', scriptOutput: null, scriptExitCode: null });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let timer = null;

      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      };

      timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutSeconds * 1000);
      if (timer && typeof timer.unref === 'function') timer.unref();

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', () => {
        settle({
          ok: false,
          code: 'script_failed',
          scriptOutput: truncateScriptOutput(stdout),
          scriptExitCode: null,
        });
      });

      child.on('close', (code) => {
        const scriptOutput = truncateScriptOutput(stdout);
        const scriptExitCode = typeof code === 'number' ? code : null;

        if (timedOut) {
          settle({ ok: false, code: 'script_timeout', scriptOutput, scriptExitCode });
          return;
        }
        if (code !== 0) {
          settle({ ok: false, code: `script_exit_${code}`, scriptOutput, scriptExitCode });
          return;
        }

        const envelope = parseEnvelope(stdout);
        if (!envelope.ok) {
          settle({ ok: false, code: 'invalid_script_output', scriptOutput, scriptExitCode });
          return;
        }
        const decision = decideEnvelope(envelope.value, task.prompt);
        if (!decision.ok) {
          settle({ ok: false, code: 'invalid_script_output', scriptOutput, scriptExitCode });
          return;
        }
        settle({ ok: true, ...decision, scriptOutput, scriptExitCode });
      });
    });
  }

  async function execute(task, run, resolution) {
    // Rows are snake_case (docs §3); accept camelCase too for callers that map first.
    const projectPath = task.project_path ?? task.projectPath ?? null;
    let sessionId = null;
    let errorText = null;
    const chunks = [];

    const collectedOutput = () => (chunks.length ? chunks.join('\n') : null);

    let effectivePrompt = task.prompt;
    let scriptExitCode = null;
    let scriptOutput = null;

    // §12.3/§12.5 step 1: resolve the parameters *before* the script gate. A
    // missing required parameter (or an invalid override) fails the run with no
    // gate and no agent call, recorded on the run row.
    const resolved = resolution ?? resolveParams(taskParamDefs(task), {});
    if (!resolved.ok) {
      return finishOnce(task, run, 'error', {
        error: resolved.code,
        promptUsed: null,
        scriptExitCode: null,
        scriptOutput: null,
      });
    }
    const paramValues = resolved.values;
    const paramVars = resolved.env;
    const paramBlock = paramsPromptBlock(resolved.params, paramValues);

    // §10.4 step 1: plan the on-disk workspace before the script gate, so the
    // layout exists even when the gate skips or fails the run. Best-effort.
    ensureTaskWorkspace(task);
    ensureRunWorkspace(task, run);
    const workspaceVars = workspaceEnv(task, { runId: run.id });
    // §13.1/§13.3: one object, built from the task and this same runId, is spread
    // into the script-gate env below and into the agent's options.env, so the two
    // paths can never disagree on a value.
    const predefinedVars = predefinedVarsEnv(task, {
      cwd: projectPath || process.cwd(),
      workspaceVars,
    });

    // §7 script gate: runs before the provider check and before any agent call.
    if (typeof task.command === 'string' && task.command.trim()) {
      if (!commandsEnabled()) {
        return finishOnce(task, run, 'error', {
          error: 'commands_disabled',
          promptUsed: null,
          scriptExitCode: null,
          scriptOutput: null,
        });
      }

      const gate = await runScriptGate(task, projectPath, predefinedVars, paramVars);
      scriptExitCode = gate.scriptExitCode ?? null;
      scriptOutput = gate.scriptOutput ?? null;

      if (!gate.ok) {
        return finishOnce(task, run, 'error', {
          error: gate.code,
          promptUsed: null,
          scriptExitCode,
          scriptOutput,
        });
      }
      if (gate.skip) {
        return finishOnce(task, run, 'skipped', {
          output: gate.reason ?? null,
          promptUsed: null,
          scriptExitCode,
          scriptOutput,
        });
      }
      effectivePrompt = gate.prompt;
    }

    // §13.5: the predefined-variables block describes every run; §12.6's
    // Parameters block is appended after it only when the task declares parameters.
    // §13.5: drop the workspace group when this run has no workspace (layer
    // disabled or unusable task id), so the text never advertises a variable the
    // run does not export.
    const predefinedBlock = predefinedVarsPromptBlock({ includeWorkspace: workspaceVars !== null });
    const extraBlocks = paramBlock ? `${predefinedBlock}\n\n${paramBlock}` : predefinedBlock;
    // §10.4 step 3: prompt.md stores the full agent-facing text, which is only
    // known once the gate has decided the effective prompt.
    ensureRunWorkspace(task, run, { effectivePrompt, paramsBlock: extraBlocks });
    // §13.5/§12.6: workspace block, then predefined variables, then Parameters.
    const promptBlocks = [];
    const workspaceBlock = workspacePromptBlock(task, { runId: run.id });
    if (workspaceBlock) promptBlocks.push(workspaceBlock);
    promptBlocks.push(predefinedBlock);
    if (paramBlock) promptBlocks.push(paramBlock);
    const agentPrompt = promptBlocks.length
      ? `${promptBlocks.join('\n\n')}\n\n${effectivePrompt}`
      : effectivePrompt;

    if (!SUPPORTED_PROVIDERS.has(task.provider ?? 'claude')) {
      return finishOnce(task, run, 'error', {
        error: `Unsupported provider: ${task.provider}`,
        promptUsed: effectivePrompt,
        scriptExitCode,
        scriptOutput,
      });
    }

    // docs §14.2: record that the agent is being started. Everything before this
    // point — the script gate (a script that runs is *not* a running task), a
    // skipped/errored gate, a params error, an unsupported provider — must stay
    // NULL so it never counts as running. Best-effort: a bookkeeping failure must
    // never break the run itself.
    const markAgentStarted = () => {
      if (typeof db.markRunAgentStarted !== 'function') return;
      try {
        db.markRunAgentStarted(run.id);
      } catch (err) {
        console.warn('[scheduled-tasks] markRunAgentStarted failed:', errorMessage(err));
      }
    };

    // Dry-run replaces only the agent call: the gate above has already run and
    // decided, and the effective prompt is reported back. The call it replaces is
    // the agent call, so the run counts as agent-started here too (§14.2).
    if (isDryRun()) {
      markAgentStarted();
      return finishOnce(task, run, 'success', {
        output: `[dry-run] ${effectivePrompt}`,
        sessionId: null,
        promptUsed: effectivePrompt,
        scriptExitCode,
        scriptOutput,
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
            if (id) {
              sessionId = id;
              // Record the link immediately so the session is tagged (and can be hidden)
              // while the run is still executing, not only once finishRun writes it.
              try {
                db.attachRunSession(run.id, id);
              } catch (err) {
                console.warn('[scheduled-tasks] attachRunSession failed:', errorMessage(err));
              }
            }
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
    // §12.5/§13.3: hand the predefined variables and the resolved parameters to the
    // provider CLI through server/claude-sdk.js, which merges options.env into
    // sdkOptions.env (only these two namespaces are accepted there).
    options.env = { ...predefinedVars, ...(paramVars ?? {}) };

    const agentResult = (status, extra = {}) =>
      finishOnce(task, run, status, {
        promptUsed: effectivePrompt,
        scriptExitCode,
        scriptOutput,
        ...extra,
      });

    const timeoutMs = resolveTimeoutMs(timeoutOverride);
    let timer = null;
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ScheduledTaskTimeoutError(`Scheduled task timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });

    // docs §14.2: the agent call starts here; project registration and prompt
    // assembly above are not agent work.
    markAgentStarted();

    try {
      await Promise.race([query(agentPrompt, options, writer), timedOut]);
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
        return agentResult('error', {
          error: errorMessage(err),
          sessionId,
          output: collectedOutput(),
        });
      }
      return agentResult('error', {
        error: errorMessage(err),
        sessionId,
        output: collectedOutput(),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    // The SDK can surface a failed turn as an 'error' message without throwing.
    if (errorText) {
      return agentResult('error', { error: errorText, sessionId, output: collectedOutput() });
    }

    return agentResult('success', { sessionId, output: collectedOutput() });
  }

  function startTaskRun(task, { trigger = 'schedule', scheduledFor = null, params: overrides } = {}) {
    // §12.5 step 5: resolve up front so createRun can store the resolved value
    // map (params_json) for audit/provenance. Resolution is pure and never throws.
    const resolution = resolveParams(taskParamDefs(task), overrides);
    const run = db.createRun({
      taskId: task.id,
      status: 'running',
      trigger,
      scheduledFor,
      startedAt: nowIso(),
      paramsJson:
        resolution.ok && resolution.params.length ? JSON.stringify(resolution.values) : null,
    });

    const done = execute(task, run, resolution).catch((err) => {
      // execute() only throws on unexpected internal faults (e.g. the DB layer).
      return finishOnce(task, run, 'error', { error: errorMessage(err) });
    });

    return { run, done };
  }

  return { startTaskRun };
}

const defaultRunner = createTaskRunner();

/**
 * @param {object} task scheduled task row
 * @param {{ trigger?: 'schedule'|'manual', scheduledFor?: string|null, params?: Record<string, unknown> }} [options]
 *   options.params is the §12.3 per-run override map.
 * @returns {{ run: object, done: Promise<{ run: object, status: string, sessionId: string|null, output: string|null, error: string|null, scriptExitCode: number|null, scriptOutput: string|null, promptUsed: string|null }> }}
 */
export function startTaskRun(task, options = {}) {
  return defaultRunner.startTaskRun(task, options);
}
