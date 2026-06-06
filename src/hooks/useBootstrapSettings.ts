import { useEffect } from 'react';
import { authenticatedFetch } from '../utils/api';

/**
 * User preference keys stored in the backend DB.
 * Must match the allowed keys in server/routes/settings.js USER_PREF_KEYS.
 */
const PREF_KEYS = [
  'claude-settings',
  'cursor-tools-settings',
  'codex-settings',
  'gemini-settings',
  'code-editor-settings',
] as const;

/**
 * Fetches all user preferences from the backend on app startup and mirrors them
 * to localStorage so that components reading localStorage directly (e.g.
 * sidebar/utils/utils.ts, useChatProviderState) have up-to-date values without
 * requiring the user to open the Settings panel first.
 *
 * Design:
 * - Runs once after AppContent mounts (user is authenticated at this point)
 * - Non-blocking: does not await before rendering
 * - Silent on failure: localStorage fallback / defaults still work
 * - Dispatches synthetic `storage` events so listeners (useSidebarController)
 *   react immediately rather than waiting for the 1-second poll interval
 */
export function useBootstrapSettings(): void {
  useEffect(() => {
    // Fire all 5 requests in parallel — they are independent and the goal is
    // to notify same-tab listeners as quickly as possible.
    // Promise.allSettled preserves per-key error isolation (one failure doesn't
    // abort the rest), and is semantically identical to the serial loop but ~5×
    // faster on a typical connection.
    void Promise.allSettled(
      PREF_KEYS.map(async (key) => {
        try {
          const res = await authenticatedFetch(`/api/settings/user-preferences/${key}`);
          if (!res.ok) return;
          const data = (await res.json()) as { value: unknown };
          if (data.value == null) return;
          const serialized = JSON.stringify(data.value);
          const oldValue = localStorage.getItem(key);
          localStorage.setItem(key, serialized);
          // Dispatch a synthetic storage event to notify same-tab listeners
          // (useSidebarController etc.). Native storage events don't fire for
          // the originating tab, so we dispatch manually.
          // storageArea and oldValue are included to match the native event spec.
          window.dispatchEvent(
            new StorageEvent('storage', {
              key,
              newValue: serialized,
              oldValue,
              storageArea: window.localStorage,
            }),
          );
        } catch {
          // Ignore network errors — components will use existing localStorage
          // values or built-in defaults.
        }
      }),
    );
  // PREF_KEYS and authenticatedFetch are stable module-level bindings; [] is correct.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
