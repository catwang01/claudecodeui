/**
 * Per-task on-disk workspace for scheduled tasks.
 *
 * Contract: docs/scheduled-tasks.md §10.4. Every scheduled task owns a directory
 * tree under `<root>/<taskId>/`:
 *
 *   task.json      machine snapshot of the task definition
 *   prompt.md      copy of the current task prompt (the DB row stays authoritative)
 *   README.md      the layout contract (the same text the agent receives)
 *   state/         durable per-task data — the only place an agent may keep state
 *   runs/<runId>/  run.json, prompt.md, output.md, logs/, tmp/
 *   tmp/           task scratch, wiped at the start of every run
 *
 * Root: `SCHEDULED_TASK_DATA_DIR` when set, otherwise
 * `~/.claudecodeui/scheduled-tasks`.
 *
 * Every function is a no-op returning `null` when `isWorkspaceEnabled()` is
 * false (`SCHEDULED_TASKS_WORKSPACE=0`), and all of them are best-effort:
 * filesystem failures are logged, never thrown to the caller (a task must still
 * run).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SCHEDULED_TASK_SCHEMA_VERSION = 1;

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

function nowIso() {
  return new Date().toISOString();
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

/** Run one best-effort filesystem operation; log and return null on failure. */
function safe(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.warn(`[scheduled-tasks] workspace.${label} failed: ${errorMessage(err)}`);
    return null;
  }
}

/** A single path segment: non-empty, no separators, never '.'/'..'. */
function resolveSegment(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

function computeRoot() {
  const override = process.env.SCHEDULED_TASK_DATA_DIR;
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.claudecodeui', 'scheduled-tasks');
}

function joinUnder(base, ...parts) {
  return base ? path.join(base, ...parts) : null;
}

function taskDirRaw(taskId) {
  const segment = resolveSegment(taskId);
  if (!segment) return null;
  return path.join(computeRoot(), segment);
}

function runDirRaw(taskId, runId) {
  const runs = joinUnder(taskDirRaw(taskId), 'runs');
  const segment = resolveSegment(runId);
  if (!runs || !segment) return null;
  return path.join(runs, segment);
}

function taskTmpDirRaw(taskId) {
  return joinUnder(taskDirRaw(taskId), 'tmp');
}

/** Gate + best-effort wrapper for the pure path helpers. */
function pathFn(label, fn) {
  if (!isWorkspaceEnabled()) return null;
  return safe(label, fn);
}

/**
 * Path templates shared by task.json/run.json and the public helpers.
 * @returns {{root: string, taskDir: string, stateDir: string, tmpDir: string, runDir: string|null}|null}
 */
function workspacePaths(taskId, runId) {
  const dir = taskDirRaw(taskId);
  if (!dir) return null;
  return {
    root: computeRoot(),
    taskDir: dir,
    stateDir: path.join(dir, 'state'),
    tmpDir: path.join(dir, 'tmp'),
    runDir: runId === undefined || runId === null ? null : runDirRaw(taskId, runId),
  };
}

// --- task row field readers (snake_case rows and camelCase views) -----------

function taskIdOf(task) {
  return task && typeof task === 'object' ? (task.id ?? null) : null;
}

function titleOf(task) {
  const title = task && typeof task === 'object' ? task.title : null;
  return title === undefined || title === null ? null : String(title);
}

function projectPathOf(task) {
  if (!task || typeof task !== 'object') return null;
  return task.project_path ?? task.projectPath ?? null;
}

function providerOf(task) {
  const provider = task && typeof task === 'object' ? task.provider : null;
  return provider ?? 'claude';
}

function modelOf(task) {
  return task && typeof task === 'object' ? (task.model ?? null) : null;
}

function kindOf(task) {
  return task && typeof task === 'object' ? (task.kind ?? null) : null;
}

function commandOf(task) {
  return task && typeof task === 'object' ? (task.command ?? null) : null;
}

function commandTimeoutOf(task) {
  if (!task || typeof task !== 'object') return null;
  const raw = task.command_timeout_seconds ?? task.commandTimeoutSeconds;
  return raw === undefined ? null : raw;
}

function updatedAtOf(task) {
  if (!task || typeof task !== 'object') return null;
  return task.updated_at ?? task.updatedAt ?? null;
}

function promptOf(task) {
  const prompt = task && typeof task === 'object' ? task.prompt : null;
  return typeof prompt === 'string' ? prompt : '';
}

/** DB row stores rule_json; views store the parsed rule. */
function parseRule(task) {
  if (!task || typeof task !== 'object') return null;
  if (task.rule && typeof task.rule === 'object') return task.rule;
  const raw = task.rule_json ?? task.ruleJson;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** task.json: machine snapshot of the task definition (§10.4). */
function taskSnapshot(task, now) {
  const snapshot = {
    schemaVersion: SCHEDULED_TASK_SCHEMA_VERSION,
    id: taskIdOf(task),
    title: titleOf(task),
    projectPath: projectPathOf(task),
    provider: providerOf(task),
    model: modelOf(task),
    kind: kindOf(task),
    rule: parseRule(task),
    command: commandOf(task),
    commandTimeoutSeconds: commandTimeoutOf(task),
    updatedAt: updatedAtOf(task) ?? now,
  };
  const url = task && typeof task === 'object' ? task.url : null;
  if (typeof url === 'string' && url.trim()) snapshot.url = url;
  return snapshot;
}

function writeFile(filePath, content) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The layout contract, in English. The same text is written to README.md and is
 * what `workspacePromptBlock()` prepends to the prompt; call it with no task to
 * get the generic text (placeholders instead of live paths), which is what the
 * schedule_* tool descriptions embed.
 */
function layoutText(task, { runId } = {}) {
  const known = !!task && typeof task === 'object';
  const taskId = known ? resolveSegment(taskIdOf(task)) : null;
  const id = taskId ?? '<task id>';
  const title = (known ? titleOf(task) : null) ?? '<task title>';
  const projectPath = (known ? projectPathOf(task) : null) ?? '<project directory>';
  const taskDir = taskId ? taskDirRaw(taskId) : null;
  const root = taskDir ?? '<task root>';
  const stateDir = taskDir ? path.join(taskDir, 'state') : '<task root>/state';
  const tmpDir = taskDir ? path.join(taskDir, 'tmp') : '<task root>/tmp';
  const runSegment = resolveSegment(runId) ?? '<runId>';
  const runDir = taskDir ? path.join(taskDir, 'runs', runSegment) : `${root}/runs/${runSegment}`;

  return [
    '## Scheduled task workspace',
    '',
    `You are running scheduled task "${title}" (task id: ${id}), run id: ${runSegment}.`,
    '',
    'The task owns this directory tree. Keep everything the task produces inside it:',
    '',
    `- Project directory (the only place you may edit project files): ${projectPath}`,
    `- Task root: ${root}`,
    `- Durable task state (${stateDir}/): keep every long-lived cache, counter or note here; it survives across runs.`,
    `- Task scratch (${tmpDir}/): wiped at the start of every run; never keep anything you need across runs there.`,
    `- This run's directory (${runDir}/):`,
    '  - prompt.md: the full prompt for this run',
    '  - output.md: the final output of this run',
    '  - logs/: log files',
    '  - tmp/: per-run scratch, removed when the run finishes',
    '',
    'Never write outside the task root and the project directory.',
  ].join('\n');
}

/** Full agent-facing prompt: workspace block + effective prompt. */
function agentPromptText(task, prompt, runId) {
  const block = layoutText(task, { runId });
  const effective = typeof prompt === 'string' ? prompt : '';
  return block ? `${block}\n\n${effective}` : effective;
}

/** run.json: run metadata + workspace paths (§10.4). */
function writeRunJson(dir, task, run, patch = {}) {
  const existing = readJsonObject(path.join(dir, 'run.json')) ?? {};
  const taskId = taskIdOf(task) ?? run?.task_id ?? run?.taskId ?? existing.taskId ?? null;
  const runId = run?.id ?? existing.runId ?? null;
  const ws = workspacePaths(taskId, runId) ?? {};
  const record = {
    schemaVersion: SCHEDULED_TASK_SCHEMA_VERSION,
    runId,
    taskId,
    title: titleOf(task) ?? run?.title ?? existing.title ?? null,
    projectPath: projectPathOf(task) ?? run?.project_path ?? existing.projectPath ?? null,
    trigger: run?.trigger ?? existing.trigger ?? null,
    scheduledFor: run?.scheduled_for ?? run?.scheduledFor ?? existing.scheduledFor ?? null,
    startedAt: run?.started_at ?? run?.startedAt ?? existing.startedAt ?? null,
    finishedAt: run?.finished_at ?? run?.finishedAt ?? existing.finishedAt ?? null,
    status: run?.status ?? existing.status ?? null,
    sessionId: run?.session_id ?? run?.sessionId ?? existing.sessionId ?? null,
    scriptExitCode: run?.script_exit_code ?? run?.scriptExitCode ?? existing.scriptExitCode ?? null,
    error: run?.error ?? existing.error ?? null,
    ...existing,
    ...patch,
    schemaVersion: SCHEDULED_TASK_SCHEMA_VERSION,
    runId,
    taskId,
    workspace: {
      root: ws.root ?? null,
      taskDir: ws.taskDir ?? null,
      stateDir: ws.stateDir ?? null,
      tmpDir: ws.tmpDir ?? null,
      runDir: ws.runDir ?? dir,
    },
  };
  writeJson(path.join(dir, 'run.json'), record);
  return record;
}

// --- public API (§10.4) -----------------------------------------------------

/** SCHEDULED_TASKS_WORKSPACE=0 disables the whole workspace layer. */
export function isWorkspaceEnabled() {
  const raw = process.env.SCHEDULED_TASKS_WORKSPACE;
  if (raw === undefined || raw === '') return true;
  return !DISABLED_VALUES.has(String(raw).toLowerCase());
}

/** Absolute workspace root (SCHEDULED_TASK_DATA_DIR override, else the home default). */
export function tasksRoot() {
  if (!isWorkspaceEnabled()) return null;
  return safe('tasksRoot', computeRoot);
}

export function taskDir(taskId) {
  return pathFn('taskDir', () => taskDirRaw(taskId));
}

export function taskStateDir(taskId) {
  return pathFn('taskStateDir', () => joinUnder(taskDirRaw(taskId), 'state'));
}

export function taskTmpDir(taskId) {
  return pathFn('taskTmpDir', () => joinUnder(taskDirRaw(taskId), 'tmp'));
}

export function taskRunsDir(taskId) {
  return pathFn('taskRunsDir', () => joinUnder(taskDirRaw(taskId), 'runs'));
}

export function runDir(taskId, runId) {
  return pathFn('runDir', () => runDirRaw(taskId, runId));
}

export function runTmpDir(taskId, runId) {
  return pathFn('runTmpDir', () => joinUnder(runDirRaw(taskId, runId), 'tmp'));
}

/**
 * Create the task directories plus task.json / prompt.md / README.md.
 * @returns {{root, taskDir, stateDir, tmpDir, runDir}|null}
 */
export function ensureTaskWorkspace(task) {
  if (!isWorkspaceEnabled()) return null;
  return safe('ensureTaskWorkspace', () => {
    const taskId = taskIdOf(task);
    const dir = taskDirRaw(taskId);
    if (!dir) return null;
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    writeJson(path.join(dir, 'task.json'), taskSnapshot(task, nowIso()));
    writeFile(path.join(dir, 'prompt.md'), promptOf(task));
    writeFile(path.join(dir, 'README.md'), layoutText(task));
    return workspacePaths(taskId, null);
  });
}

/**
 * Create this run's directory plus run.json and prompt.md.
 * `effectivePrompt` defaults to the task prompt; pass the post-gate prompt to
 * refresh prompt.md with the full agent-facing text.
 * @returns {{root, taskDir, stateDir, tmpDir, runDir}|null}
 */
export function ensureRunWorkspace(task, run, { effectivePrompt } = {}) {
  if (!isWorkspaceEnabled()) return null;
  return safe('ensureRunWorkspace', () => {
    const taskId = taskIdOf(task) ?? run?.task_id ?? run?.taskId ?? null;
    const runId = run?.id ?? null;
    const dir = runDirRaw(taskId, runId);
    if (!dir) return null;
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    const prompt = effectivePrompt === undefined || effectivePrompt === null ? promptOf(task) : effectivePrompt;
    writeFile(path.join(dir, 'prompt.md'), agentPromptText(task, prompt, runId));
    writeRunJson(dir, task, run);
    return workspacePaths(taskId, runId);
  });
}

/** Wipe the task scratch dir before a run, then recreate it empty. */
export function clearTaskTmp(taskId) {
  if (!isWorkspaceEnabled()) return null;
  return safe('clearTaskTmp', () => {
    const dir = taskTmpDirRaw(taskId);
    if (!dir) return null;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
}

/**
 * Record the run outcome: output.md, run.json status and per-run tmp cleanup
 * (kept when SCHEDULED_TASK_KEEP_RUN_TMP=1). The script-gate stdout is saved to
 * logs/gate-stdout.log when present.
 */
export function finalizeRunWorkspace(task, run, patch = {}) {
  if (!isWorkspaceEnabled()) return null;
  return safe('finalizeRunWorkspace', () => {
    const taskId = taskIdOf(task) ?? run?.task_id ?? run?.taskId ?? null;
    const runId = run?.id ?? null;
    const dir = runDirRaw(taskId, runId);
    if (!dir) return null;
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

    const output = typeof patch.output === 'string' && patch.output ? patch.output : null;
    const errorText = typeof patch.error === 'string' && patch.error ? patch.error : null;
    writeFile(path.join(dir, 'output.md'), output ?? errorText ?? '');

    if (typeof patch.scriptOutput === 'string' && patch.scriptOutput) {
      writeFile(path.join(dir, 'logs', 'gate-stdout.log'), patch.scriptOutput);
    }

    const finalPatch = {
      finishedAt: patch.finishedAt ?? nowIso(),
      sessionId: patch.sessionId ?? null,
      error: errorText,
      scriptExitCode: patch.scriptExitCode ?? null,
    };
    // Keep the last known status when the caller does not provide one.
    if (patch.status !== undefined) finalPatch.status = patch.status;
    writeRunJson(dir, task, run, finalPatch);

    if (process.env.SCHEDULED_TASK_KEEP_RUN_TMP !== '1') {
      fs.rmSync(path.join(dir, 'tmp'), { recursive: true, force: true });
    }
    return workspacePaths(taskId, runId);
  });
}

/**
 * Extra environment for the script gate (§10.4): the five SCHEDULED_TASK_* vars.
 * @returns {Record<string, string>|null}
 */
export function workspaceEnv(task, { runId } = {}) {
  if (!isWorkspaceEnabled()) return null;
  return safe('workspaceEnv', () => {
    const taskId = taskIdOf(task);
    const dir = taskDirRaw(taskId);
    if (!dir) return null;
    const segment = resolveSegment(runId);
    return {
      SCHEDULED_TASK_DIR: dir,
      SCHEDULED_TASK_STATE_DIR: path.join(dir, 'state'),
      SCHEDULED_TASK_TMP_DIR: path.join(dir, 'tmp'),
      SCHEDULED_TASK_RUN_ID: segment ?? '',
      SCHEDULED_TASK_RUN_DIR: segment ? runDirRaw(taskId, segment) : '',
    };
  });
}

/**
 * Markdown block prepended to the prompt the agent receives (§10.4). Without a
 * task (or without a run id) it falls back to placeholders, which is the text the
 * schedule_* tool descriptions embed.
 * @returns {string|null}
 */
export function workspacePromptBlock(task, { runId } = {}) {
  if (!isWorkspaceEnabled()) return null;
  return safe('workspacePromptBlock', () => layoutText(task, { runId: resolveSegment(runId) }));
}
