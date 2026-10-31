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
// §17 retention: how many run rows to keep per task when nothing overrides it.
const DEFAULT_RUN_RETENTION = 50;

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

  /** §17: per-task run retention (deps > env > app_config > default). */
  async function resolveRunRetention() {
    if (typeof deps.runRetention === 'function') return deps.runRetention();
    const envValue = parseInt(process.env.SCHEDULED_TASK_RUN_RETENTION, 10);
    if (Number.isFinite(envValue)) return envValue;
    try {
      const db = await import('../modules/database/index.js');
      const parsed = parseInt(db.appConfigDb?.get?.('scheduled_task_run_retention'), 10);
      if (Number.isFinite(parsed)) return parsed;
    } catch (err) {
      logger.warn?.('[scheduled-tasks] retention lookup failed: ' + errorMessage(err));
    }
    return DEFAULT_RUN_RETENTION;
  }

  /** §17: drop the oldest runs of a task beyond the retention count. Best-effort. */
  async function pruneTaskRuns(repo, taskId) {
    if (typeof repo.pruneRuns !== 'function') return;
    try {
      const keep = await resolveRunRetention();
      if (!Number.isFinite(keep) || keep < 1) return;
      repo.pruneRuns(taskId, keep);
    } catch (err) {
      logger.warn?.(`[scheduled-tasks] pruneRuns(${taskId}) failed: ${errorMessage(err)}`);
    }
  }

  async function prepareAndStart(task, trigger, nowMs, options = {}) {
    const repo = await getRepo();
    const runner = await getRunner();

    let nextRunAt = task.next_run_at ?? null;
    if (trigger === 'schedule') {
      const computeNextRun = await getComputeNextRun();
      nextRunAt = computeNextFor(task, nowMs, computeNextRun);

      // Advance BEFORE executing (crash-safe): the same occurrence cannot fire twice.
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
    }

    const scheduledFor = trigger === 'schedule' ? (task.next_run_at ?? null) : null;
    // §12.3: a manual run may carry a per-run parameter override map.
    const { run, done } = runner.startTaskRun(task, { trigger, scheduledFor, params: options.params });

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
          repo.advanceTask(task.id, {
            nextRunAt,
            lastRunAt,
            lastStatus: result?.status ?? 'error',
            lastError: result?.error ?? null,
            runCount: (task.run_count ?? 0) + 1,
          });
        } catch (err) {
          logger.error?.(
            `[scheduled-tasks] post-run advanceTask(${task.id}) failed: ${errorMessage(err)}`
          );
        }
        // §17: retention is applied after the run settles, so the just-finished
        // run is kept and only older ones are dropped.
        await pruneTaskRuns(repo, task.id);
        return result;
      });

    return { run, settled };
  }

  /**
   * Start a run for a task. Resolves as soon as the run row exists; the returned
   * 'settled' promise resolves when the run and its bookkeeping are done.
   * Never rejects.
   */
  function launch(task, trigger, nowMs, options = {}) {
    const token = (launchSeq += 1);
    generation.set(task.id, token);
    const started = (async () => {
      const { run, settled } = await prepareAndStart(task, trigger, nowMs, options);
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
        if (generation.get(task.id) !== token) return;
        generation.delete(task.id);
        inFlight.delete(task.id);
        inFlightRun.delete(task.id);
        const next = pending.get(task.id);
        if (next) {
          pending.delete(task.id);
          pendingLaunches += 1;
          void drainPending(task.id, next).finally(() => {
            pendingLaunches -= 1;
          });
        }
      });

    inFlightRun.set(task.id, tracked);
    return safe;
  }

  /** §17 'queue': remember the trigger; the newest one wins (at most one per task). */
  function enqueue(taskId, entry) {
    pending.set(taskId, entry);
  }

  async function drainPending(taskId, entry) {
    const repo = await getRepo();
    const task = repo.getTask(taskId);
    // A queued run never resurrects a task that was deleted or, for a scheduled
    // trigger, paused while it waited.
    if (!task || inFlight.has(taskId)) return;
    if (entry.trigger === 'schedule' && !task.enabled) return;
    inFlight.add(taskId);
    launch(task, entry.trigger, entry.nowMs, entry.options);
  }

  /** Wait for the active run to settle, bounded so 'replace' can never hang. */
  async function waitForActive(taskId) {
    const active = inFlightRun.get(taskId);
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
  async function replaceAndLaunch(task, trigger, nowMs, options = {}) {
    const runner = await getRunner();
    if (typeof runner.abortTaskRun === 'function') {
      try {
        await runner.abortTaskRun(task.id);
      } catch (err) {
        logger.warn?.(`[scheduled-tasks] abortTaskRun(${task.id}) failed: ${errorMessage(err)}`);
      }
    }
    await waitForActive(task.id);
    inFlight.delete(task.id);
    inFlightRun.delete(task.id);
    inFlight.add(task.id);
    return launch(task, trigger, nowMs, options);
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
        if (inFlight.has(task.id)) {
          // §17: the previous run is still going — honour the task's policy.
          if (policy === 'replace') {
            pendingLaunches += 1;
            void replaceAndLaunch(task, 'schedule', nowMs).finally(() => {
              pendingLaunches -= 1;
            });
          } else if (policy === 'queue') {
            enqueue(task.id, { task, trigger: 'schedule', nowMs, options: {} });
          }
          continue;
        }
        // Mark in-flight synchronously so a concurrent tick cannot double-dispatch.
        inFlight.add(task.id);
        launch(task, 'schedule', nowMs);
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
      for (const [taskId, entry] of entries) {
        pending.delete(taskId);
        await drainPending(taskId, entry);
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

    if (inFlight.has(taskId)) {
      // §17: the previous run is still going — honour the task's policy.
      if (policy === 'replace') {
        const entry = await replaceAndLaunch(task, 'manual', now(), options);
        const run = entry?.run;
        if (!run) {
          inFlight.delete(taskId);
          return { error: 'internal_error' };
        }
        return { run, replaced: true };
      }
      if (policy === 'queue') {
        enqueue(taskId, { task, trigger: 'manual', nowMs: now(), options });
        return { queued: true };
      }
      return { error: 'in_flight' };
    }

    inFlight.add(taskId);
    const { run } = await launch(task, 'manual', now(), options);
    if (!run) {
      inFlight.delete(taskId);
      return { error: 'internal_error' };
    }
    return { run };
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

  return { tick, start, stop, runNow, state, whenIdle, reconcileInterrupted, runningCount };
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

export function getSchedulerState() {
  if (!defaultScheduler) {
    return { running: false, tickMs: envTickMs(), inFlight: [] };
  }
  return defaultScheduler.state();
}
