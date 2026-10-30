/**
 * Scheduled task scheduler service.
 *
 * Owns the tick loop that turns due tasks into runs. Contract: docs/scheduled-tasks.md §4.
 *
 *   createScheduler(deps?) -> { tick(), start(), stop(), runNow(taskId), state(), whenIdle() }
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
 */

const DEFAULT_TICK_MS = 30000;
const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

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

  async function prepareAndStart(task, trigger, nowMs) {
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
    const { run, done } = runner.startTaskRun(task, { trigger, scheduledFor });

    const settled = Promise.resolve(done)
      .catch((err) => ({
        run,
        status: 'error',
        sessionId: null,
        output: null,
        error: errorMessage(err),
      }))
      .then((result) => {
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
        return result;
      });

    return { run, settled };
  }

  /**
   * Start a run for a task. Resolves as soon as the run row exists; the returned
   * 'settled' promise resolves when the run and its bookkeeping are done.
   * Never rejects.
   */
  function launch(task, trigger, nowMs) {
    const started = (async () => {
      const { run, settled } = await prepareAndStart(task, trigger, nowMs);
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
        inFlight.delete(task.id);
        inFlightRun.delete(task.id);
      });

    inFlightRun.set(task.id, tracked);
    return safe;
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
        if (!task || !task.id || inFlight.has(task.id)) continue;
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

  /** Await every in-flight run (used by tests and shutdown). */
  async function whenIdle() {
    while (inFlightRun.size > 0) {
      await Promise.allSettled([...inFlightRun.values()]);
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

  async function runNow(taskId) {
    const repo = await getRepo();
    const task = repo.getTask(taskId);
    if (!task) return { error: 'not_found' };
    if (inFlight.has(taskId)) return { error: 'in_flight' };

    inFlight.add(taskId);
    const { run } = await launch(task, 'manual', now());
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

  return { tick, start, stop, runNow, state, whenIdle };
}

// ─── Module-level default scheduler ────────────────────────────────────────────

let defaultScheduler = null;

function getDefaultScheduler() {
  if (!defaultScheduler) defaultScheduler = createScheduler();
  return defaultScheduler;
}

export function startScheduledTaskService() {
  const scheduler = getDefaultScheduler();
  if (scheduler.state().running) return;
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
 * @returns {Promise<{ run: object } | { error: 'not_found'|'in_flight'|'internal_error' }>}
 */
export async function runScheduledTaskNow(taskId) {
  return getDefaultScheduler().runNow(taskId);
}

export function getSchedulerState() {
  if (!defaultScheduler) {
    return { running: false, tickMs: envTickMs(), inFlight: [] };
  }
  return defaultScheduler.state();
}
