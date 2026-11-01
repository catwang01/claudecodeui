import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { running, wsListeners } = vi.hoisted(() => ({
  running: vi.fn(),
  wsListeners: new Set<(message: unknown) => void>(),
}));

vi.mock('../api', () => ({
  scheduledTasksApi: { running: () => running() },
}));

// Section 15: the hook applies the count and the run list pushed over /ws
// before it polls again.
vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({
    subscribeMessages: (listener: (message: unknown) => void) => {
      wsListeners.add(listener);
      return () => {
        wsListeners.delete(listener);
      };
    },
  }),
}));

import { useRunningScheduledTasks } from './useRunningScheduledTasks';

// Rendering these trees is cheap, but CI/dev boxes can be heavily loaded, so
// keep a generous per-test budget instead of relying on the 5s default.
vi.setConfig({ testTimeout: 30000 });

const RUN = {
  id: 'run-1',
  taskId: 'task-1',
  taskTitle: 'Task',
  projectPath: '/tmp/a',
  projectPaths: ['/tmp/a'],
  status: 'running',
  trigger: 'schedule',
  scheduledFor: null,
  startedAt: null,
  agentStartedAt: null,
  sessionId: null,
  error: null,
};

type RunningPayload = { count: number; runs: unknown[] };

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
}

describe('useRunningScheduledTasks', () => {
  beforeEach(() => {
    running.mockReset();
    wsListeners.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Drop the own-property override so jsdom's prototype getter applies again.
    Reflect.deleteProperty(document, 'hidden');
  });

  it('polls on the interval, exposes the runs and clears the interval on unmount', async () => {
    vi.useFakeTimers();
    running.mockResolvedValue({ count: 2, runs: [] });

    const { result, unmount } = renderHook(() => useRunningScheduledTasks({ intervalMs: 10000 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(running).toHaveBeenCalledTimes(1);
    expect(result.current.count).toBe(2);

    running.mockResolvedValue({ count: 3, runs: [RUN] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(running).toHaveBeenCalledTimes(2);
    expect(result.current.count).toBe(3);
    expect(result.current.runs).toEqual([RUN]);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(running).toHaveBeenCalledTimes(2);
  });

  it('skips requests while hidden and refreshes as soon as it is visible again', async () => {
    setHidden(true);
    running.mockResolvedValue({ count: 5, runs: [] });

    const { result } = renderHook(() => useRunningScheduledTasks({ intervalMs: 60000 }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(running).not.toHaveBeenCalled();
    expect(result.current.count).toBe(0);

    setHidden(false);
    running.mockResolvedValue({ count: 2, runs: [RUN] });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(result.current.count).toBe(2));
    expect(running).toHaveBeenCalledTimes(1);
    expect(result.current.runs).toEqual([RUN]);
  });

  it('keeps the last count and runs when the request fails', async () => {
    running.mockResolvedValueOnce({ count: 4, runs: [RUN] });

    const { result } = renderHook(() => useRunningScheduledTasks({ intervalMs: 60000 }));
    await waitFor(() => expect(result.current.count).toBe(4));

    running.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.count).toBe(4);
    expect(result.current.runs).toEqual([RUN]);
  });

  it('applies the server push immediately and drops an older in-flight poll', async () => {
    let resolvePoll: ((value: RunningPayload) => void) | null = null;
    running.mockImplementationOnce(
      () =>
        new Promise<RunningPayload>((resolve) => {
          resolvePoll = resolve;
        }),
    );

    const { result } = renderHook(() => useRunningScheduledTasks({ intervalMs: 60000 }));
    await waitFor(() => expect(running).toHaveBeenCalledTimes(1));

    await act(async () => {
      wsListeners.forEach((listener) =>
        listener({ type: 'scheduled_task_running_count', count: 3, runs: [RUN] }),
      );
    });
    expect(result.current.count).toBe(3);
    expect(result.current.runs).toEqual([RUN]);

    // The poll that was already in flight resolves later with the old value.
    await act(async () => {
      resolvePoll?.({ count: 0, runs: [] });
      await Promise.resolve();
    });
    expect(result.current.count).toBe(3);
    expect(result.current.runs).toEqual([RUN]);
    expect(running).toHaveBeenCalledTimes(1);
  });

  it('refetches when an older server pushes a count without a run list', async () => {
    running.mockResolvedValue({ count: 1, runs: [RUN] });
    const { result } = renderHook(() => useRunningScheduledTasks({ intervalMs: 60000 }));
    await waitFor(() => expect(result.current.count).toBe(1));

    running.mockResolvedValue({ count: 2, runs: [RUN, { ...RUN, id: 'run-2' }] });
    await act(async () => {
      wsListeners.forEach((listener) => listener({ type: 'scheduled_task_running_count', count: 2 }));
    });

    await waitFor(() => expect(result.current.count).toBe(2));
    expect(result.current.runs).toHaveLength(2);
  });

  it('ignores unrelated websocket messages', async () => {
    running.mockResolvedValue({ count: 1, runs: [] });
    const { result } = renderHook(() => useRunningScheduledTasks({ intervalMs: 60000 }));
    await waitFor(() => expect(result.current.count).toBe(1));

    await act(async () => {
      wsListeners.forEach((listener) => listener({ type: 'projects_updated' }));
    });
    expect(result.current.count).toBe(1);
  });

  it('drops a stale response that resolves after a newer one', async () => {
    let resolveFirst: ((value: RunningPayload) => void) | null = null;
    running.mockImplementationOnce(
      () =>
        new Promise<RunningPayload>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    running.mockResolvedValueOnce({ count: 7, runs: [] });

    const { result } = renderHook(() => useRunningScheduledTasks({ intervalMs: 60000 }));
    await waitFor(() => expect(running).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.count).toBe(7);

    await act(async () => {
      resolveFirst?.({ count: 99, runs: [] });
      await Promise.resolve();
    });
    expect(result.current.count).toBe(7);
  });
});
