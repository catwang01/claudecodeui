/**
 * Fork tree UI state — shared across the Recents view and the Projects view.
 *
 * Keeps two pieces of state:
 *   - `mode`: whether fork sessions render as an indented tree or as a flat
 *     time-sorted list. Persisted under `sidebar-fork-tree-mode`.
 *   - `collapsedIds`: which fork-tree roots have their descendants hidden.
 *     Persisted under `sidebar-fork-collapsed`.
 *
 * Both views observe the same store via `useForkTreeState()` so that a
 * collapse in one view is reflected instantly in the other.
 *
 * Legacy `recents-fork-tree-mode` / `recents-fork-collapsed` keys are read
 * once on init for backward compatibility.
 */

type Listener = () => void;

const MODE_KEY = 'sidebar-fork-tree-mode';
const COLLAPSED_KEY = 'sidebar-fork-collapsed';
const LEGACY_MODE_KEY = 'recents-fork-tree-mode';
const LEGACY_COLLAPSED_KEY = 'recents-fork-collapsed';

function readMode(): boolean {
  try {
    const v = localStorage.getItem(MODE_KEY) ?? localStorage.getItem(LEGACY_MODE_KEY);
    return v !== 'false';
  } catch {
    return true;
  }
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY) ?? localStorage.getItem(LEGACY_COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr as string[]) : new Set();
  } catch {
    return new Set();
  }
}

let mode = readMode();
let collapsed = readCollapsed();
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

function persistMode() {
  try { localStorage.setItem(MODE_KEY, String(mode)); } catch { /* noop */ }
}

function persistCollapsed() {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* noop */ }
}

export const forkTreeStore = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  getMode(): boolean {
    return mode;
  },
  setMode(next: boolean) {
    if (mode === next) return;
    mode = next;
    persistMode();
    emit();
  },
  toggleMode() {
    mode = !mode;
    persistMode();
    emit();
  },
  getCollapsed(): Set<string> {
    return collapsed;
  },
  isCollapsed(id: string): boolean {
    return collapsed.has(id);
  },
  toggleCollapse(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
    persistCollapsed();
    emit();
  },
};

// Cross-tab sync: if another tab changes the persisted state, mirror it here.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === MODE_KEY) {
      const next = readMode();
      if (next !== mode) { mode = next; emit(); }
    } else if (e.key === COLLAPSED_KEY) {
      collapsed = readCollapsed();
      emit();
    }
  });
}
