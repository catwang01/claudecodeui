// @vitest-environment node
/**
 * Tests for the file-system watcher debounce logic.
 *
 * Bug: 'add' events (new session created) and 'change' events (existing session
 * being written) share the same debounce timer.  If an active session keeps
 * emitting 'change' events during the debounce window, the timer is reset on
 * every change and the 'add' event is starved — the new session never appears
 * in the sidebar until the active session goes quiet for a full debounce period.
 *
 * Fix: 'add' / 'addDir' / 'unlink' / 'unlinkDir' events should bypass the
 * rolling debounce and fire the callback immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatcherDebounce } from './watcher-debounce.js';

describe('watcher debounce — new-session starvation bug', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('add event fires the callback even when a change event immediately follows it', async () => {
        const callback = vi.fn().mockResolvedValue(undefined);
        const DEBOUNCE_MS = 300;
        const { handle } = createWatcherDebounce({ debounceMs: DEBOUNCE_MS, callback });

        // A new session is created (add)
        handle('add', '/project/session-new.jsonl');

        // Bug: a 'change' event on the OLD session arrives 50ms later,
        // clearing the add's timer and replacing it with a change closure.
        // The 'add' callback is now lost and will never be called.
        vi.advanceTimersByTime(50);
        handle('change', '/project/session-old.jsonl');

        // Advance past the full debounce window so the change timer fires
        vi.advanceTimersByTime(DEBOUNCE_MS + 50);
        await vi.runAllTimersAsync();

        // The 'add' callback MUST have fired — it should not be silently dropped
        const addCalls = callback.mock.calls.filter(([t]) => t === 'add');
        expect(addCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('change events are still debounced and do not fire on every write', async () => {
        const callback = vi.fn().mockResolvedValue(undefined);
        const DEBOUNCE_MS = 300;
        const { handle } = createWatcherDebounce({ debounceMs: DEBOUNCE_MS, callback });

        // 5 rapid change events within the debounce window
        for (let i = 0; i < 5; i++) {
            handle('change', '/project/session.jsonl');
            vi.advanceTimersByTime(50);
        }

        vi.advanceTimersByTime(DEBOUNCE_MS + 50);
        await vi.runAllTimersAsync();

        const changeCalls = callback.mock.calls.filter(([t]) => t === 'change');
        expect(changeCalls.length).toBe(1);
    });

    it('add event does not block a subsequent change debounce', async () => {
        const callback = vi.fn().mockResolvedValue(undefined);
        const DEBOUNCE_MS = 300;
        const { handle } = createWatcherDebounce({ debounceMs: DEBOUNCE_MS, callback });

        handle('add', '/project/session-new.jsonl');
        await vi.runAllTimersAsync();
        callback.mockClear();

        // After the add fires, change events should still debounce normally
        handle('change', '/project/session-new.jsonl');
        handle('change', '/project/session-new.jsonl');
        vi.advanceTimersByTime(DEBOUNCE_MS + 50);
        await vi.runAllTimersAsync();

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][0]).toBe('change');
    });
});
