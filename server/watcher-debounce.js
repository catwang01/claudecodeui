/**
 * createWatcherDebounce — fixes the new-session starvation bug.
 *
 * Rules:
 *  - 'add' / 'addDir' / 'unlink' / 'unlinkDir' → fire callback immediately (no debounce).
 *  - 'change' → debounced by debounceMs (rolling timer, resets on each call).
 *
 * This ensures a newly-created session (add) is never dropped or delayed
 * by concurrent change events from an active session.
 *
 * @param {object} options
 * @param {number} options.debounceMs   - debounce window for 'change' events (ms)
 * @param {function} options.callback   - async (eventType, filePath) => void
 * @returns {{ handle: function }}
 */
export function createWatcherDebounce({ debounceMs, callback }) {
    let changeTimer = null;

    function handle(eventType, filePath) {
        if (eventType === 'change') {
            // Debounce: reset the timer on every change event
            if (changeTimer) clearTimeout(changeTimer);
            changeTimer = setTimeout(() => {
                changeTimer = null;
                callback(eventType, filePath).catch(() => {});
            }, debounceMs);
        } else {
            // Structural events (add, addDir, unlink, unlinkDir) fire immediately
            callback(eventType, filePath).catch(() => {});
        }
    }

    return { handle };
}
