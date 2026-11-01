/**
 * Scheduled task scheduler service.
 *
 * Owns the tick loop that turns due tasks into runs. Contract: docs/scheduled-tasks.md §4.
 *
 *   createScheduler(deps?) -> { tick(), start(), stop(), runNow(taskId), state(), whenIdle(),
 *                               reconcileInterrupted(error?) }
 *   startScheduledTaskService() / stopScheduledTaskService()
 *   runScheduledTaskNow(taskId) / getSchedulerState()
 *
 * deps: { repo, runner, now, tickMs, logger, computeNextRun }
 *   - repo / runner / computeNextRun default to lazily imported real modules so the
 *     scheduler can be unit-tested with fakes.
 *
 * Crash-safety: nextRunAt is advanced *before* the run starts, so a crash mid-run
 * cannot make the same occurrence fire twice. Completion then advances the task
 * again with lastRunAt/lastStatus/lastError/runCount.
 *
 * Env: SCHEDULED_TASKS_ENABLED (default on), SCHEDULED_TASKS_TICK_MS (default 30000).
 *
 * Interrupted runs (§14.1): an agent is a child of this process, so nothing can
 * still be running after a restart. startScheduledTaskService() (async since
 * §14.1) sweeps leftover 'running' rows to error *before* the first tick, so a
 * crash can neither inflate the running-task count nor leave a run in progress
 * forever. createScheduler() itself never mutates rows.
 */

const DEFAULT_TICK_MS = 30000;
const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);
// §17 conflict policy: how a due task behaves while its previous run is in flight.
const CONFLICT_POLICIES = new Set(['skip', 'queue', 'replace']);
// §17 'replace': how long to wait for the aborted run to settle before starting
// the new one anyway (the generation token keeps the stale run's cleanup harmless).
const REPLACE_ABORT_TIMEOUT_MS = 5000;

function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

function envTickMs() {
  const raw = parseInt(process.env.SCHEDULED_TASKS_TICK_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TICK_MS;
}

function isEnabled() {
  const raw = process.env.SCHEDULED_TASKS_ENABLED;
  if (raw === undefined || raw === '') return true;
  return !DISABLED_VALUES.has(String(raw).toLowerCase());
}

// ─── Lazy defaults (kept lazy so unit tests can inject fakes) ──────────────────

let cachedRunner = null;
async function loadDefaultRunner() {
  if (!cachedRunner) {
    const mod = await import('./runner.js');
    cachedRunner =
      typeof mod.createTaskRunner === 'function'
        ? mod.createTaskRunner()
        : { startTaskRun: mod.startTaskRun };
  }
  return cachedRunner;
}

async function loadDefaultRepo() {
  const db = await import('../modules/database/index.js');
  return db.scheduledTasksDb;
}

let cachedComputeNextRun = null;
async function loadDefaultComputeNextRun() {
  if (!cachedComputeNextRun) {
    const rules = await import('./rules.js');
    cachedComputeNextRun = rules.computeNextRun;
  }
  return cachedComputeNextRun;
}

function parseRule(task) {
  const raw = task.rule_json ?? task.ruleJson;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * §22: every project a task is bound to; a legacy single-project row reads as
 * [project_path]. Used to fan one due task out into one run per project.
 */
function projectPathsOf(task) {
  if (!task || typeof task !== 'object') return [];
  const raw = task.project_paths_json ?? task.projectPaths;
  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      // unreadable JSON reads as the single project path
    }
  }
  const paths = [];
  for (const value of list ?? []) {
    if (typeof value === 'string' && value.trim() && !paths.includes(value.trim())) paths.push(value.trim());
  }
  if (paths.length) return paths;
  const single = task.project_path ?? task.projectPath;
  return typeof single === 'string' && single.trim() ? [single] : [];
}

/** §22: the in-flight / queue key of one (task, project) run. */
function keyOf(taskId, projectPath) {
  return String(taskId) + '::' + String(projectPath ?? '');
}

/**
 * @param {object} [deps]
 * @param {string} [deps.repo] injected repository (defaults to scheduledTasksDb)
 */
export function createScheduler(deps = {}) {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  let repoRef = deps.repo ?? null;
  let runnerRef = deps.runner ?? null;
  let computeNextRunRef = deps.computeNextRun ?? null;

  const inFlight = new Set();
  const inFlightRun = new Map();
  // §17: at most one queued trigger per task (the newest wins).
  const pending = new Map();
  // §17: a monotonic token per launch; a stale run's finally must not clear the
  // state of the run that replaced it.
  const generation = new Map();
  let launchSeq = 0;
  // §17: async successors (queue drain / replace) that have been scheduled but
  // have not registered in inFlightRun yet, so whenIdle() cannot return early.
  let pendingLaunches = 0;
  let running = false;
  let ticking = false;
  let timer = null;

  async function getRepo() {
    if (!repoRef) repoRef = await loadDefaultRepo();
    return repoRef;
  }

  async function getRunner() {
    if (!runnerRef) runnerRef = await loadDefaultRunner();
    return runnerRef;
  }

  async function getComputeNextRun() {
    if (!computeNextRunRef) computeNextRunRef = await loadDefaultComputeNextRun();
    return computeNextRunRef;
  }

  function currentTickMs() {
    if (Number.isFinite(deps.tickMs) && deps.tickMs > 0) return deps.tickMs;
    return envTickMs();
  }

  function computeNextFor(task, fromMs, computeNextRun) {
    // A one-shot task is exhausted once it has been dispatched.
    if ((task.kind ?? '') === 'once') return null;
    const rule = parseRule(task);
    if (!rule) return null;
    try {
      const ms = computeNextRun(rule, fromMs);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    } catch (err) {
      logger.warn?.(`[scheduled-tasks] computeNextRun failed for ${task.id}: ${errorMessage(err)}`);
      return null;
    }
  }

  function conflictPolicyOf(task) {
    const value = task?.conflict_policy ?? task?.conflictPolicy;
    return CONFLICT_POLICIES.has(value) ? value : 'skip';
  }

  async function prepareAndStart(task, projectPath, trigger, nowMs, options = {}) {
    const repo = await getRepo();
    const runner = await getRunner();

    // §22: tick() already advanced the schedule once for this occurrence, before
    // any fan-out run started; each run only reports its own outcome back.
    const nextRunAt = options.nextRunAt;
    const scheduledFor =
      trigger === 'schedule' ? (options.scheduledFor ?? task.next_run_at ?? null) : null;
    // §12.3: a manual run may carry a per-run parameter override map.
    // §22: projectPath is the project this run targets.
    const { run, done } = runner.startTaskRun(task, {
      trigger,
      scheduledFor,
      params: options.params,
      projectPath,
    });

    const settled = Promise.resolve(done)
      .catch((err) => ({
        run,
        status: 'error',
        sessionId: null,
        output: null,
        error: errorMessage(err),
      }))
      .then(async (result) => {
        const lastRunAt =
          result?.run?.finished_at ?? new Date(now()).toISOString();
        try {
          // §22: read the fresh row so a multi-project fan-out counts every run
          // (the runs settle one after another, not from the stale tick snapshot).
          const fresh = typeof repo.getTask === 'function' ? repo.getTask(task.id) : null;
          repo.advanceTask(task.id, {
            nextRunAt,
            lastRunAt,
            lastStatus: result?.status ?? 'error',
            lastError: result?.error ?? null,
            runCount: (fresh?.run_count ?? task.run_count ?? 0) + 1,
          });
        } catch (err) {
          logger.error?.(
            `[scheduled-tasks] post-run advanceTask(${task.id}) failed: ${errorMessage(err)}`
          );
        }
        return result;
      });

    return { run, settled };
  }

  /**
   * Start a run for a task. Resolves as soon as the run row exists; the returned
   * 'settled' promise resolves when the run and its bookkeeping are done.
   * Never rejects.
   */
  function launch(task, projectPath, trigger, nowMs, options = {}) {
    // §22: the in-flight key is (task, project), so a multi-project task can run
    // one project per key; a single-project task keeps exactly one key.
    const key = keyOf(task.id, projectPath);
    const token = (launchSeq += 1);
    generation.set(key, token);
    const started = (async () => {
      const { run, settled } = await prepareAndStart(task, projectPath, trigger, nowMs, options);
      return { run, settled };
    })();

    const safe = started.catch((err) => {
      logger.error?.(`[scheduled-tasks] startTaskRun(${task.id}) failed: ${errorMessage(err)}`);
      return { run: null, settled: Promise.resolve(null) };
    });

    const tracked = safe
      .then((entry) => entry.settled)
      .catch(() => null)
      .finally(() => {
        // A run that was replaced must not clear the state of its successor.
        if (generation.get(key) !== token) return;
        generation.delete(key);
        inFlight.delete(key);
        inFlightRun.delete(key);
        const next = pending.get(key);
        if (next) {
          pending.delete(key);
          pendingLaunches += 1;
          void drainPending(key, next).finally(() => {
            pendingLaunches -= 1;
          });
        }
      });

    inFlightRun.set(key, tracked);
    return safe;
  }

  /** §17 'queue': remember the trigger; the newest one wins (one per run key). */
  function enqueue(key, entry) {
    pending.set(key, entry);
  }

  async function drainPending(key, entry) {
    const repo = await getRepo();
    const task = repo.getTask(entry.taskId);
    // A queued run never resurrects a task that was deleted or, for a scheduled
    // trigger, paused while it waited.
    if (!task || inFlight.has(key)) return;
    if (entry.trigger === 'schedule' && !task.enabled) return;
    inFlight.add(key);
    launch(task, entry.projectPath, entry.trigger, entry.nowMs, entry.options);
  }

  /** Wait for the active run to settle, bounded so 'replace' can never hang. */
  async function waitForActive(key) {
    const active = inFlightRun.get(key);
    if (!active) return;
    await Promise.race([
      active.catch(() => null),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, REPLACE_ABORT_TIMEOUT_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  }

  /** §17 'replace': abort the active run's agent, wait briefly, then start anew. */
  async function replaceAndLaunch(task, projectPath, trigger, nowMs, options = {}) {
    const runner = await getRunner();
    const key = keyOf(task.id, projectPath);
    if (typeof runner.abortTaskRun === 'function') {
      try {
        // §22: only this project's run is replaced.
        await runner.abortTaskRun(task.id, projectPath ?? null);
      } catch (err) {
        logger.warn?.(`[scheduled-tasks] abortTaskRun(${task.id}) failed: ${errorMessage(err)}`);
      }
    }
    await waitForActive(key);
    inFlight.delete(key);
    inFlightRun.delete(key);
    inFlight.add(key);
    return launch(task, projectPath, trigger, nowMs, options);
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!isEnabled()) return;
      const repo = await getRepo();
      const nowMs = now();
      const due = await repo.listDueTasks(new Date(nowMs).toISOString());
      for (const task of due ?? []) {
        if (!task || !task.id) continue;
        const policy = conflictPolicyOf(task);
        // §22: advance the schedule exactly once for this occurrence, before any
        // of the task's runs starts (crash-safe: it cannot fire twice).
        const computeNextRun = await getComputeNextRun();
        const nextRunAt = computeNextFor(task, nowMs, computeNextRun);
        try {
          repo.advanceTask(task.id, {
            nextRunAt,
            lastRunAt: task.last_run_at ?? null,
            lastStatus: task.last_status ?? null,
            lastError: task.last_error ?? null,
            runCount: task.run_count ?? 0,
          });
        } catch (err) {
          logger.error?.(
            `[scheduled-tasks] pre-run advanceTask(${task.id}) failed: ${errorMessage(err)}`
          );
        }
        const scheduledFor = task.next_run_at ?? null;
        // §22: fan out one run per bound project; each project follows the
        // task's conflict policy independently.
        const projectPaths = projectPathsOf(task);
        for (const projectPath of projectPaths.length ? projectPaths : [null]) {
          const key = keyOf(task.id, projectPath);
          if (inFlight.has(key)) {
            // §17: this project's previous run is still going — honour the policy.
            if (policy === 'replace') {
              pendingLaunches += 1;
              void replaceAndLaunch(task, projectPath, 'schedule', nowMs, {
                nextRunAt,
                scheduledFor,
              }).finally(() => {
                pendingLaunches -= 1;
              });
            } else if (policy === 'queue') {
              enqueue(key, {
                taskId: task.id,
                projectPath,
                trigger: 'schedule',
                nowMs,
                options: { nextRunAt, scheduledFor },
              });
            }
            continue;
          }
          // Mark in-flight synchronously so a concurrent tick cannot double-dispatch.
          inFlight.add(key);
          launch(task, projectPath, 'schedule', nowMs, { nextRunAt, scheduledFor });
        }
      }
    } catch (err) {
      logger.error?.(`[scheduled-tasks] tick failed: ${errorMessage(err)}`);
    } finally {
      ticking = false;
    }
  }

  /** Await every in-flight run and any queued successor (used by tests and shutdown). */
  async function whenIdle() {
    for (let guard = 0; guard < 100; guard += 1) {
      if (inFlightRun.size === 0 && pending.size === 0 && pendingLaunches === 0) return;
      if (inFlightRun.size > 0) {
        await Promise.allSettled([...inFlightRun.values()]);
        continue;
      }
      // A queue entry whose previous run already settled and whose drain has not
      // started yet: drain it now so whenIdle() cannot return early.
      const entries = [...pending.entries()];
      if (entries.length === 0) {
        // No queue and no in-flight run, but a replace/drain is still between
        // "previous run settled" and "successor registered": yield and re-check.
        if (pendingLaunches === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      for (const [key, entry] of entries) {
        pending.delete(key);
        await drainPending(key, entry);
      }
    }
  }

  function scheduleNext() {
    if (!running) return;
    const tickMs = currentTickMs();
    timer = setTimeout(async () => {
      await tick();
      scheduleNext();
    }, tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (running) return;
    running = true;
    // Fire overdue tasks immediately, then keep a recursive setTimeout loop so a
    // changed tick interval takes effect on the next cycle.
    void tick();
    scheduleNext();
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function runNow(taskId, options = {}) {
    const repo = await getRepo();
    const task = repo.getTask(taskId);
    if (!task) return { error: 'not_found' };
    const policy = conflictPolicyOf(task);

    // §22: a manual run fans out over every bound project unless the caller
    // targets one; each project follows the task's conflict policy on its own.
    const projectPaths = options.projectPath ? [options.projectPath] : projectPathsOf(task);
    const targets = projectPaths.length ? projectPaths : [null];
    const runs = [];
    let queued = false;
    let inFlightCount = 0;

    for (const projectPath of targets) {
      const key = keyOf(taskId, projectPath);
      if (inFlight.has(key)) {
        // §17: this project's previous run is still going — honour the policy.
        if (policy === 'replace') {
          const entry = await replaceAndLaunch(task, projectPath, 'manual', now(), options);
          if (entry?.run) runs.push(entry.run);
          else inFlight.delete(key);
        } else if (policy === 'queue') {
          enqueue(key, { taskId, projectPath, trigger: 'manual', nowMs: now(), options });
          queued = true;
        } else {
          inFlightCount += 1;
        }
        continue;
      }

      inFlight.add(key);
      const { run } = await launch(task, projectPath, 'manual', now(), options);
      if (run) runs.push(run);
      else inFlight.delete(key);
    }

    if (runs.length) return { run: runs[0], runs };
    if (queued) return { queued: true };
    if (inFlightCount) return { error: 'in_flight' };
    return { error: 'internal_error' };
  }

  function state() {
    return {
      running,
      tickMs: currentTickMs(),
      inFlight: [...inFlight],
    };
  }

  /**
   * docs §14.1: fail every run left 'running' by a previous process. Only
   * startScheduledTaskService() calls this — createScheduler() itself must stay
   * pure so unit tests keep an untouched repository.
   */
  async function reconcileInterrupted(error = 'server_restart') {
    const repo = await getRepo();
    if (typeof repo.failInterruptedRuns !== 'function') return 0;
    try {
      return repo.failInterruptedRuns(new Date(now()).toISOString(), error) || 0;
    } catch (err) {
      logger.warn?.(`[scheduled-tasks] failInterruptedRuns failed: ${errorMessage(err)}`);
      return 0;
    }
  }

  /**
   * docs §15: the running-task count, read on the server so a /ws notification
   * can carry the exact number instead of making every client refetch.
   */
  async function runningCount() {
    const repo = await getRepo();
    if (typeof repo.countRunningAgentRuns !== 'function') return 0;
    try {
      const count = repo.countRunningAgentRuns();
      return Number.isFinite(count) ? count : 0;
    } catch (err) {
      logger.warn?.(`[scheduled-tasks] countRunningAgentRuns failed: ${errorMessage(err)}`);
      return 0;
    }
  }

  /**
   * §22: the full running view (count + run list) behind GET /running and the
   * /ws push. Delegates to the management view layer so both surfaces share one
   * serializer; a failure degrades to the count with an empty list.
   */
  async function runningTasks(limit = 50) {
    try {
      const { createManagement } = await import('./management.js');
      const management = createManagement({ repo: await getRepo() });
      const result = await management.listRunningTasks(limit);
      if (result.ok) return { count: result.count, runs: result.runs };
    } catch (err) {
      logger.warn?.('[scheduled-tasks] runningTasks failed: ' + errorMessage(err));
    }
    return { count: await runningCount(), runs: [] };
  }

  return { tick, start, stop, runNow, state, whenIdle, reconcileInterrupted, runningCount, runningTasks };
}

// ─── Module-level default scheduler ────────────────────────────────────────────

let defaultScheduler = null;

function getDefaultScheduler() {
  if (!defaultScheduler) defaultScheduler = createScheduler();
  return defaultScheduler;
}

/**
 * Async since §14.1: the interrupted-run sweep must finish *before* the first
 * tick, otherwise it could fail a run that tick just created. It never rejects.
 */
export async function startScheduledTaskService() {
  const scheduler = getDefaultScheduler();
  if (scheduler.state().running) return;
  // Sweep before the enabled check: GET /running is readable either way, and a
  // row left 'running' by a crash must not be reported as running forever.
  try {
    const failed = await scheduler.reconcileInterrupted('server_restart');
    if (failed > 0) {
      console.log(`[scheduled-tasks] marked ${failed} interrupted run(s) as error`);
    }
  } catch (err) {
    console.warn(`[scheduled-tasks] interrupted-run sweep failed: ${errorMessage(err)}`);
  }
  if (!isEnabled()) {
    console.log('[scheduled-tasks] Scheduler disabled (SCHEDULED_TASKS_ENABLED)');
    return;
  }
  scheduler.start();
  console.log(`[scheduled-tasks] Scheduler started (tick: ${scheduler.state().tickMs}ms)`);
}

export function stopScheduledTaskService() {
  if (defaultScheduler) defaultScheduler.stop();
}

/**
 * @param {string} taskId
 * @param {{ params?: Record<string, unknown> }} [options] §12.3 per-run overrides
 * @returns {Promise<{ run: object } | { error: 'not_found'|'in_flight'|'internal_error' }>}
 */
export async function runScheduledTaskNow(taskId, options = {}) {
  return getDefaultScheduler().runNow(taskId, options);
}

/**
 * docs §15: used by the /ws broadcaster in server/index.js. Never rejects.
 * @returns {Promise<number>}
 */
export async function getRunningTaskCount() {
  return getDefaultScheduler().runningCount();
}

/**
 * docs §22: count + run list for the /ws push. Never rejects.
 * @returns {Promise<{count: number, runs: Array}>}
 */
export async function getRunningScheduledTasks(limit = 50) {
  return getDefaultScheduler().runningTasks(limit);
}

export function getSchedulerState() {
  if (!defaultScheduler) {
    return { running: false, tickMs: envTickMs(), inFlight: [] };
  }
  return defaultScheduler.state();
}
