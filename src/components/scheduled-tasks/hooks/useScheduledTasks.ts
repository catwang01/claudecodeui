import { useCallback, useEffect, useRef, useState } from 'react';
import { scheduledTasksApi } from '../api';
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskPatch, TaskStatusFilter } from '../types';

/** Keep next-run/last-status reasonably fresh while the panel is open. */
const AUTO_REFRESH_MS = 20000;

export function useScheduledTasks(params: { status: TaskStatusFilter; search: string }) {
  const { status, search } = params;
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsLoading(true);
    try {
      const next = await scheduledTasksApi.list({ status, search });
      if (requestId !== requestIdRef.current) return;
      setTasks(next);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [status, search]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handle = window.setInterval(() => {
      void refresh();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [refresh]);

  const createTask = useCallback(
    async (input: ScheduledTaskInput): Promise<void> => {
      await scheduledTasksApi.create(input);
      await refresh();
    },
    [refresh],
  );

  const updateTask = useCallback(
    async (id: string, patch: ScheduledTaskPatch): Promise<void> => {
      await scheduledTasksApi.update(id, patch);
      await refresh();
    },
    [refresh],
  );

  const deleteTask = useCallback(
    async (id: string): Promise<void> => {
      await scheduledTasksApi.remove(id);
      await refresh();
    },
    [refresh],
  );

  const runNow = useCallback(
    async (id: string): Promise<void> => {
      await scheduledTasksApi.runNow(id);
      await refresh();
    },
    [refresh],
  );

  return { tasks, isLoading, error, refresh, createTask, updateTask, deleteTask, runNow };
}
