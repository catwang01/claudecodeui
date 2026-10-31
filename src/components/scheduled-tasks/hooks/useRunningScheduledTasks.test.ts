import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { runningCount } = vi.hoisted(() => ({ runningCount: vi.fn() }));

vi.mock('../api', () => ({
  scheduledTasksApi: { runningCount: () => runningCount() },
}));

import { useRunningScheduledTasks } from './useRunningScheduledTasks';

// Rendering these trees is cheap, but CI/dev boxes can be heavily loaded, so
// keep a generous per-test budget instead of relying on the 5s default.
vi.setConfig({ testTimeout: 30000 });

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
}

describe('useRunningScheduledTasks', () => {
  beforeEach(() => {
    runningCount.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Drop the own-property override so jsdom's prototype getter applies again.
    Reflect.deleteProperty(document, 'hidden');
  });

  it('polls on the interval and clears the interval on unmount', async () => {
    vi.useFakeTimers();
    runningCount.mockResolvedValue(2);

    const { result, unmount } = renderHook(() => useRunningScheduledTasks({ intervalMs: 10000 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runningCount).toHaveBeenCalledTimes(1);
    expect(result.current.count).toBe(2);

    runningCount.mockResolvedValue(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(runningCount).toHaveBeenCalledTimes(2);
    expect(result.current.count).toBe(3);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(runningCount).toHaveBeenCalledTimes(2);
  });

  it('skips requests while hidden and refreshes as soon as it is visible again', async () => {
    setHidden(true);
    runningCount.mockResolvedValue(5);

    const { result } = renderHook(() => useRunningScheduledTasks({ intervalMs: 60000 }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(runningCount).not.toHaveBeenCalled();
    expect(result.current.count).toBe(0);

    setHidden(false);
    runningCount.mockResolvedValue(2);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(result.current.count).toBe(2));
    expect(runningCount).toHaveBeenCalledTimes(1);
  });

  it('keeps the last count when the request fails', async () => {
    runningCount.mockResolvedValueOnce(4);

    const { result } = renderHook(() => useRunningScheduledTasks({ intervalMs: 60000 }));
    await waitFor(() => expect(result.current.count).toBe(4));

    runningCount.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.count).toBe(4);
  });

  it('drops a stale response that resolves after a newer one', async () => {
    let resolveFirst: ((value: number) => void) | null = null;
    runningCount.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    runningCount.mockResolvedValueOnce(7);

    const { result } = renderHook(() => useRunningScheduledTasks({ intervalMs: 60000 }));
    await waitFor(() => expect(runningCount).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.count).toBe(7);

    await act(async () => {
      resolveFirst?.(99);
      await Promise.resolve();
    });
    expect(result.current.count).toBe(7);
  });
});
