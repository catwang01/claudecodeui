import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';
import { sessionSynchronizerService } from './session-synchronizer.service.js';
import { ALL_SYNCHRONIZERS } from '../registry.js';

type BroadcastFn = (message: Record<string, unknown>) => void;
type GetProjectsFn = () => Promise<unknown[]>;

let watchers: FSWatcher[] = [];
let pendingUpdate: {
  changeTypes: string[];
  providers: string[];
  sessionIds: (string | null)[];
} | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
let getProjectsFn: GetProjectsFn | null = null;
let broadcastFn: BroadcastFn | null = null;

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 2000;

function queuePendingUpdate(
  changeType: string,
  provider: string,
  sessionId: string | null
): void {
  if (!pendingUpdate) {
    pendingUpdate = { changeTypes: [], providers: [], sessionIds: [] };
  }
  if (!pendingUpdate.changeTypes.includes(changeType)) pendingUpdate.changeTypes.push(changeType);
  if (!pendingUpdate.providers.includes(provider)) pendingUpdate.providers.push(provider);
  if (sessionId && !pendingUpdate.sessionIds.includes(sessionId)) {
    pendingUpdate.sessionIds.push(sessionId);
  }
  schedulePendingFlush();
}

function schedulePendingFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { void flushPendingUpdate(); }, DEBOUNCE_MS);

  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(() => { void flushPendingUpdate(); }, MAX_WAIT_MS);
  }
}

async function flushPendingUpdate(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }

  const pending = pendingUpdate;
  pendingUpdate = null;

  if (!pending || !getProjectsFn || !broadcastFn) return;

  try {
    const projects = await getProjectsFn();
    broadcastFn({
      type: 'projects_updated',
      projects,
      timestamp: new Date().toISOString(),
      changeType: pending.changeTypes[0] ?? 'change',
      changeTypes: pending.changeTypes,
      watchProvider: pending.providers[0] ?? 'unknown',
      watchProviders: pending.providers,
      updatedSessionIds: pending.sessionIds.filter(Boolean),
      batched: pending.sessionIds.length > 1,
    });
  } catch (err) {
    console.error('[sessions-watcher] flush failed:', err);
  }
}

function providerForFile(filePath: string): string {
  for (const synchronizer of ALL_SYNCHRONIZERS) {
    if (synchronizer.watchPaths.some(wp => filePath.startsWith(wp))) {
      return synchronizer.provider;
    }
  }
  return 'claude';
}

/**
 * Filter the legacy watcher's roots (`setupProjectsWatcher` in `server/index.js`)
 * down to the ones this sessions watcher may safely skip because the legacy watcher
 * already covers them.
 *
 * Only claude qualifies: its layout `~/.claude/projects/<cwd>/<sessionId>.jsonl`
 * sits at depth 1 — exactly what the legacy watcher (`depth: 1`) sees — so watching
 * it here too syncs the DB and broadcasts `projects_updated` twice for every change
 * (issue #55).
 *
 * Codex is deliberately excluded even though it shares a root with the legacy
 * watcher: real codex sessions live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * (depth 3). The legacy `depth: 1` watcher never sees those files — it also ignores
 * `addDir`, so newly created date directories don't help either. Covering codex here
 * would leave codex with no effective watcher (no `projects_updated` on codex
 * writes), so codex must stay on this unlimited-depth watcher.
 */
export function legacyCoveredPaths(
  legacyRoots: { provider: string; rootPath: string }[],
): string[] {
  return legacyRoots
    .filter(({ provider }) => provider === 'claude')
    .map(({ rootPath }) => rootPath);
}

export function initializeSessionsWatcher(opts: {
  getProjects: GetProjectsFn;
  broadcast: BroadcastFn;
  /**
   * Absolute paths already watched by the legacy projects watcher
   * (`setupProjectsWatcher` in `server/index.js`). Any synchronizer watchPath
   * resolving to one of these is skipped so the two watchers don't both sync +
   * broadcast the same file change; synchronizers left with no paths are dropped
   * entirely (issue #55). Callers should derive this via `legacyCoveredPaths()`,
   * which excludes providers (codex) the legacy depth:1 watcher can't actually see.
   */
  coveredPaths?: string[];
}): void {
  getProjectsFn = opts.getProjects;
  broadcastFn = opts.broadcast;

  const covered = new Set((opts.coveredPaths ?? []).map((p) => path.resolve(p)));

  // Keep only watch paths the legacy watcher does not already cover.
  const activeSynchronizers = ALL_SYNCHRONIZERS.map((synchronizer) => ({
    synchronizer,
    watchPaths: synchronizer.watchPaths.filter((wp) => !covered.has(path.resolve(wp))),
  })).filter((entry) => entry.watchPaths.length > 0);

  const allPaths = activeSynchronizers.flatMap((entry) => entry.watchPaths);

  if (allPaths.length === 0) return;

  const onUpdate = (changeType: string, filePath: string): void => {
    const provider = providerForFile(filePath);
    if (!filePath.endsWith('.jsonl') && !filePath.endsWith('.json')) return;

    sessionSynchronizerService
      .synchronizeProviderFile(provider, filePath)
      .then((sessionId) => queuePendingUpdate(changeType, provider, sessionId))
      .catch((err) => console.error('[sessions-watcher] onUpdate error:', err));
  };

  watchers = activeSynchronizers.map(({ synchronizer, watchPaths }) => {
    const watcher = chokidar.watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,
      ...(synchronizer.provider === 'copilot' ? { depth: 1 } : {}),
      ignored: (filePath) => {
        const resolvedPath = path.resolve(filePath);
        const isExplicitlyWatched = watchPaths.some((watchPath) => {
          const resolvedWatchPath = path.resolve(watchPath);
          return resolvedPath === resolvedWatchPath
            || resolvedPath.startsWith(`${resolvedWatchPath}${path.sep}`);
        });
        return !isExplicitlyWatched && /(^|[/\\])\../.test(filePath);
      },
    });

    watcher
      .on('add', (fp) => onUpdate('add', fp))
      .on('change', (fp) => onUpdate('change', fp))
      .on('unlink', (fp) => onUpdate('unlink', fp));
    return watcher;
  });
}

export async function closeSessionsWatcher(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  if (maxWaitTimer) clearTimeout(maxWaitTimer);
  await Promise.all(watchers.map((watcher) => watcher.close()));
  watchers = [];
}
