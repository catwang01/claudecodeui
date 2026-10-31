import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { scheduledTasksApi } from '../api';

/**
 * Safety-net interval. The server pushes the exact count over /ws the moment an
 * agent starts or a run finishes (section 15), so this only heals a missed push
 * (a dropped socket, a reload race) instead of being the primary source.
 */
const DEFAULT_INTERVAL_MS = 15000;

/**
 * Returns the number of scheduled tasks whose agent has actually been started
 * (section 14) — the script-gate phase and a run that will be skipped never count.
 *
 * Freshness:
 * - `scheduled_task_running_count` WS pushes update the count immediately (section 15).
 * - Polls the REST endpoint as a fallback, skips requests while the document is
 *   hidden, and refreshes right away on visibilitychange / window focus.
 * - Drops stale responses (request id guard) and keeps the last known value when a
 *   request fails, so a transient error never flashes "0".
 */
export function useRunningScheduledTasks({
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  intervalMs?: number;
} = {}) {
  const [count, setCount] = useState(0);
  const requestIdRef = useRef(0);
  const { subscribeMessages } = useWebSocket();

  const refresh = useCallback(async (): Promise<void> => {
    // A hidden tab is not watching the badge; polling it anyway would only add
    // load. Coming back to visible triggers an immediate refresh below.
    if (document.hidden) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const next = await scheduledTasksApi.runningCount();
      if (requestId !== requestIdRef.current) return;
      setCount(next);
    } catch {
      // Keep the previous value: a transient failure must not flash "0".
    }
  }, []);

  // Section 15: apply server pushes synchronously and invalidate any in-flight
  // poll so it cannot overwrite the newer pushed value.
  useEffect(() => {
    return subscribeMessages((message: Record<string, unknown> | null) => {
      if (!message || message.type !== 'scheduled_task_running_count') return;
      const next = message.count;
      if (typeof next !== 'number' || !Number.isFinite(next)) return;
      requestIdRef.current += 1;
      setCount(next);
    });
  }, [subscribeMessages]);

  useEffect(() => {
    void refresh();
    const handle = window.setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => window.clearInterval(handle);
  }, [refresh, intervalMs]);

  useEffect(() => {
    const catchUp = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('focus', catchUp);
    return () => {
      document.removeEventListener('visibilitychange', catchUp);
      window.removeEventListener('focus', catchUp);
    };
  }, [refresh]);

  return { count, refresh };
}
