import chokidar, { type FSWatcher } from 'chokidar';
import { sessionSynchronizerService } from './session-synchronizer.service.js';
import { ALL_SYNCHRONIZERS } from '../registry.js';

type BroadcastFn = (message: Record<string, unknown>) => void;
type GetProjectsFn = () => Promise<unknown[]>;

let watcher: FSWatcher | null = null;
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

export function initializeSessionsWatcher(opts: {
  getProjects: GetProjectsFn;
  broadcast: BroadcastFn;
}): void {
  getProjectsFn = opts.getProjects;
  broadcastFn = opts.broadcast;

  sessionSynchronizerService.synchronizeSessions().catch((err) => {
    console.error('[sessions-watcher] initial sync failed:', err);
  });

  const allPaths = ALL_SYNCHRONIZERS.flatMap(s => s.watchPaths);

  if (allPaths.length === 0) return;

  watcher = chokidar.watch(allPaths, {
    persistent: true,
    ignoreInitial: true,
    ignored: /(^|[/\\])\../,
  });

  const onUpdate = (changeType: string, filePath: string): void => {
    if (!filePath.endsWith('.jsonl') && !filePath.endsWith('.json')) return;

    const provider = providerForFile(filePath);
    sessionSynchronizerService
      .synchronizeProviderFile(provider, filePath)
      .then((sessionId) => queuePendingUpdate(changeType, provider, sessionId))
      .catch((err) => console.error('[sessions-watcher] onUpdate error:', err));
  };

  watcher
    .on('add', (fp) => onUpdate('add', fp))
    .on('change', (fp) => onUpdate('change', fp))
    .on('unlink', (fp) => onUpdate('unlink', fp));
}

export async function closeSessionsWatcher(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  if (maxWaitTimer) clearTimeout(maxWaitTimer);
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}
