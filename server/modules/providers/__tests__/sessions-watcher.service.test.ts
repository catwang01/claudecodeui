import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (filePath: string) => void>();
  const watcher = {
    on: vi.fn((event: string, handler: (filePath: string) => void) => {
      handlers.set(event, handler);
      return watcher;
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    handlers,
    watcher,
    watch: vi.fn(() => watcher),
    synchronize: vi.fn().mockResolvedValue(1),
    synchronizeProviderFile: vi.fn().mockResolvedValue(null),
    synchronizeSessions: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('chokidar', () => ({
  default: { watch: mocks.watch },
}));

vi.mock('../registry.js', () => ({
  ALL_SYNCHRONIZERS: [
    {
      provider: 'claude',
      watchPaths: ['C:\\Users\\test\\.claude\\projects'],
      synchronize: vi.fn(),
      synchronizeFile: vi.fn(),
    },
    {
      provider: 'codex',
      watchPaths: ['C:\\Users\\test\\.codex\\sessions'],
      synchronize: vi.fn(),
      synchronizeFile: vi.fn(),
    },
    {
      provider: 'copilot',
      watchPaths: [
        'C:\\Users\\test\\.copilot\\session-state',
        'C:\\Users\\test\\.copilot\\session-store.db',
      ],
      synchronize: mocks.synchronize,
      synchronizeFile: vi.fn(),
    },
  ],
}));

vi.mock('../services/session-synchronizer.service.js', () => ({
  sessionSynchronizerService: {
    synchronizeSessions: mocks.synchronizeSessions,
    synchronizeProviderFile: mocks.synchronizeProviderFile,
  },
}));

import {
  closeSessionsWatcher,
  initializeSessionsWatcher,
  legacyCoveredPaths,
} from '../services/sessions-watcher.service.js';

describe('sessions watcher', () => {
  afterEach(async () => {
    await closeSessionsWatcher();
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('does not run a full Copilot sync for global session store changes', async () => {
    initializeSessionsWatcher({
      getProjects: vi.fn().mockResolvedValue([]),
      broadcast: vi.fn(),
    });

    mocks.handlers.get('change')?.('C:\\Users\\test\\.copilot\\session-store.db');

    await Promise.resolve();

    expect(mocks.synchronize).not.toHaveBeenCalled();
    expect(mocks.synchronizeProviderFile).not.toHaveBeenCalled();
  });

  it('does not start a second provider-wide synchronization during watcher setup', async () => {
    initializeSessionsWatcher({
      getProjects: vi.fn().mockResolvedValue([]),
      broadcast: vi.fn(),
    });

    await Promise.resolve();

    expect(mocks.synchronizeSessions).not.toHaveBeenCalled();
  });

  it('limits Copilot watcher traversal to native session files', () => {
    initializeSessionsWatcher({
      getProjects: vi.fn().mockResolvedValue([]),
      broadcast: vi.fn(),
    });

    expect(mocks.watch).toHaveBeenCalledWith(
      [
        'C:\\Users\\test\\.copilot\\session-state',
        'C:\\Users\\test\\.copilot\\session-store.db',
      ],
      expect.objectContaining({ depth: 1 })
    );
    expect(mocks.watch).toHaveBeenCalledWith(
      ['C:\\Users\\test\\.claude\\projects'],
      expect.not.objectContaining({ depth: expect.anything() })
    );
  });

  it('skips claude (covered by the legacy depth:1 watcher) but keeps codex watched', () => {
    const legacyRoots = [
      { provider: 'claude', rootPath: 'C:\\Users\\test\\.claude\\projects' },
      { provider: 'codex', rootPath: 'C:\\Users\\test\\.codex\\sessions' },
    ];
    initializeSessionsWatcher({
      getProjects: vi.fn().mockResolvedValue([]),
      broadcast: vi.fn(),
      coveredPaths: legacyCoveredPaths(legacyRoots),
    });

    const watchedPathSets = mocks.watch.mock.calls.map(
      (call) => (call as unknown as [string[]])[0],
    );
    // claude is covered by the legacy depth:1 watcher → not watched a second time here.
    expect(watchedPathSets).not.toContainEqual(['C:\\Users\\test\\.claude\\projects']);
    // codex is NOT covered — its sessions are 3 levels deep, so the legacy depth:1
    // watcher can't see them → codex must keep this watcher (issue #55).
    expect(watchedPathSets).toContainEqual(['C:\\Users\\test\\.codex\\sessions']);
    // copilot is not covered → still watched.
    expect(watchedPathSets).toContainEqual([
      'C:\\Users\\test\\.copilot\\session-state',
      'C:\\Users\\test\\.copilot\\session-store.db',
    ]);
  });

  it('treats only claude as legacy-covered, never codex', () => {
    expect(
      legacyCoveredPaths([
        { provider: 'claude', rootPath: 'C:\\Users\\test\\.claude\\projects' },
        { provider: 'codex', rootPath: 'C:\\Users\\test\\.codex\\sessions' },
        { provider: 'cursor', rootPath: 'C:\\Users\\test\\.cursor\\chats' },
        { provider: 'gemini', rootPath: 'C:\\Users\\test\\.gemini\\projects' },
      ]),
    ).toEqual(['C:\\Users\\test\\.claude\\projects']);
  });

  it('ignores Copilot session database writes', async () => {
    initializeSessionsWatcher({
      getProjects: vi.fn().mockResolvedValue([]),
      broadcast: vi.fn(),
    });

    mocks.handlers.get('change')?.(
      'C:\\Users\\test\\.copilot\\session-state\\live-session\\session.db'
    );

    await Promise.resolve();

    expect(mocks.synchronizeProviderFile).not.toHaveBeenCalled();
  });
});
