/**
 * Scheduled-task run state events (docs §15).
 *
 * The runner emits; server/index.js subscribes and forwards the fresh running-task
 * count over the existing /ws connection, so an open UI updates the badge the moment
 * an agent starts or a run finishes instead of waiting for its safety-net poll.
 *
 * The registry lives here (not in index.js) so the runner and the scheduler stay free
 * of HTTP / WebSocket dependencies and remain unit-testable in isolation.
 */

const listeners = new Set();

/**
 * @param {(event: { phase: 'agent_started'|'finished', runId: string, taskId: string|null, status?: string }) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onScheduledTaskRunState(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Notify every subscriber. Never throws: a broken subscriber must never break a
 * scheduled run, and the runner already treats its own bookkeeping as best-effort.
 */
export function emitScheduledTaskRunState(event) {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch {
      // Subscriber failures are not the runner's problem.
    }
  }
}
