import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { scheduledTasksApi } from '../api';
import type { RunningScheduledTaskRun } from '../types';

const DEFAULT_INTERVAL_MS = 15000;

/**
 * docs §22: the live running runs (count + list).
 *
 * The server pushes `scheduled_task_running_count` with `{ count, runs }` the
 * moment an agent starts or a run finishes, so the panel updates without a poll
 * (section 15). A 15s poll is the safety net for a dropped push, a reconnect or
 * a page that was hidden. A transient failure keeps the previous value.
 */
export function useRunningScheduledTasks({
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  intervalMs?: number;
} = {}) {
  const [count, setCount] = useState(0);
  const [runs, setRuns] = useState<RunningScheduledTaskRun[]>([]);
  const requestIdRef = useRef(0);
  const { subscribeMessages } = useWebSocket();

  const refresh = useCallback(async (): Promise<void> => {
    if (document.hidden) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const next = await scheduledTasksApi.running();
      if (requestId !== requestIdRef.current) return;
      setCount(next.count);
      setRuns(next.runs);
    } catch {
      // Keep the previous value: a transient failure must not flash "0".
    }
  }, []);

  useEffect(() => {
    return subscribeMessages((message: Record<string, unknown> | null) => {
      if (!message || message.type !== 'scheduled_task_running_count') return;
      const next = message.count;
      if (typeof next === 'number' && Number.isFinite(next)) {
        requestIdRef.current += 1;
        setCount(next);
      }
      // §22: the push also carries the list; an older server that only sends the
      // count makes the hook refetch so the list stays fresh.
      if (Array.isArray(message.runs)) {
        requestIdRef.current += 1;
        setRuns(message.runs as RunningScheduledTaskRun[]);
      } else {
        void refresh();
      }
    });
  }, [subscribeMessages, refresh]);

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

  return { count, runs, refresh };
}
