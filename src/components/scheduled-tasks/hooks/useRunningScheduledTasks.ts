import { useCallback, useEffect, useRef, useState } from 'react';
import { scheduledTasksApi } from '../api';

/** How often the sidebar launcher re-reads the running-task count. */
const DEFAULT_INTERVAL_MS = 10000;

/**
 * Polls GET /api/scheduled-tasks/running (section 14) and returns the number of
 * tasks whose agent has actually been started.
 *
 * - Skips the request entirely while the document is hidden.
 * - Refreshes immediately when the document becomes visible again.
 * - Drops stale responses (request id guard, like useScheduledTasks).
 * - Keeps the last known count when a request fails.
 */
export function useRunningScheduledTasks({
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  intervalMs?: number;
} = {}) {
  const [count, setCount] = useState(0);
  const requestIdRef = useRef(0);

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

  useEffect(() => {
    void refresh();
    const handle = window.setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => window.clearInterval(handle);
  }, [refresh, intervalMs]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refresh]);

  return { count, refresh };
}
