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
  ALL_SYNCHRONIZERS: [{
    provider: 'copilot',
    watchPaths: [
      'C:\\Users\\test\\.copilot\\session-state',
      'C:\\Users\\test\\.copilot\\session-store.db',
    ],
    synchronize: mocks.synchronize,
    synchronizeFile: vi.fn(),
  }],
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
