import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  all: vi.fn(),
  get: vi.fn(),
  close: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  access: mocks.access,
}));

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function MockDatabase() {
    return {
      prepare: mocks.prepare,
      close: mocks.close,
    };
  }),
}));

vi.mock('@/modules/database/index.js', () => ({
  sessionsDb: {
    createSession: vi.fn(),
    clearSessionCustomNameIfMatches: vi.fn(),
    updateSessionGeneratedSummaryIfEmpty: vi.fn(),
    getSessionByProviderSessionId: vi.fn(),
    getSessionById: vi.fn(),
  },
  projectsDb: {
    createProjectPath: vi.fn(),
  },
}));

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  copilotSessionSynchronizer,
  waitForCopilotSessionSummary,
} from '../list/copilot/copilot-session-synchronizer.provider.js';

describe('copilotSessionSynchronizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue(undefined);
    vi.mocked(sessionsDb.getSessionByProviderSessionId).mockReturnValue(null);
    vi.mocked(sessionsDb.getSessionById).mockReturnValue(null);
    mocks.prepare.mockImplementation((query: string) => ({
      all: query.includes('FROM sessions') ? mocks.all : vi.fn(),
      get: mocks.get,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not watch the global database because updates are synchronized by session id', () => {
    expect(copilotSessionSynchronizer.watchPaths).not.toContain(
      path.join(os.homedir(), '.copilot', 'session-store.db')
    );
  });

  it('does not import an unindexed native session older than the shared cursor', async () => {
    mocks.all.mockReturnValue([
      {
        id: 'historical-session',
        cwd: 'C:\\repo',
        summary: 'Historical conversation',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);

    const count = await copilotSessionSynchronizer.synchronize(
      new Date('2026-01-01T00:00:00.000Z')
    );

    expect(count).toBe(0);
    expect(mocks.prepare).toHaveBeenCalledWith(
      'SELECT id, cwd, summary, created_at, updated_at FROM sessions'
    );
    expect(projectsDb.createProjectPath).not.toHaveBeenCalled();
    expect(sessionsDb.createSession).not.toHaveBeenCalled();
    expect(sessionsDb.updateSessionGeneratedSummaryIfEmpty).not.toHaveBeenCalled();
  });

  it('backfills a historical summary without rewriting an existing session', async () => {
    mocks.all.mockReturnValue([{
      id: 'historical-session',
      cwd: 'C:\\repo',
      summary: 'Historical conversation',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    }]);
    vi.mocked(sessionsDb.getSessionByProviderSessionId).mockReturnValue({
      session_id: 'cloud-session',
      provider: 'copilot',
      provider_session_id: 'historical-session',
      project_path: 'C:\\repo',
      jsonl_path: 'C:\\managed\\cloud-session.jsonl',
      custom_name: null,
      generated_summary: null,
      isArchived: 0,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    });

    const count = await copilotSessionSynchronizer.synchronize(
      new Date('2026-01-01T00:00:00.000Z')
    );

    expect(count).toBe(1);
    expect(sessionsDb.updateSessionGeneratedSummaryIfEmpty).toHaveBeenCalledWith(
      'cloud-session',
      'Historical conversation'
    );
    expect(sessionsDb.createSession).not.toHaveBeenCalled();
    expect(projectsDb.createProjectPath).not.toHaveBeenCalled();
  });

  it('replaces a legacy managed transcript with native Copilot events when available', async () => {
    const nativeSessionId = 'native-session';
    const managedSessionId = 'managed-session';
    const nativeEventsPath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      nativeSessionId,
      'events.jsonl'
    );
    mocks.all.mockReturnValue([{
      id: nativeSessionId,
      cwd: 'C:\\repo',
      summary: 'Native session',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    }]);
    vi.mocked(sessionsDb.getSessionByProviderSessionId).mockReturnValue({
      session_id: managedSessionId,
      provider: 'copilot',
      provider_session_id: nativeSessionId,
      project_path: 'C:\\repo',
      jsonl_path: 'C:\\Users\\test\\.claude\\projects\\repo\\managed-session.jsonl',
      custom_name: null,
      generated_summary: null,
      isArchived: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });

    await copilotSessionSynchronizer.synchronize(null);

    expect(sessionsDb.createSession).toHaveBeenCalledWith(
      managedSessionId,
      'copilot',
      'C:\\repo',
      undefined,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      nativeEventsPath,
      nativeSessionId
    );
  });

  it('uses session.db changes to refresh metadata without indexing the database as JSONL', async () => {
    mocks.get.mockReturnValue({
      id: 'live-session',
      cwd: 'C:\\repo',
      summary: 'Live conversation',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
    const sessionDir = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      'live-session'
    );

    const result = await copilotSessionSynchronizer.synchronizeFile(
      path.join(sessionDir, 'session.db')
    );

    expect(result).toBe('live-session');
    expect(sessionsDb.createSession).toHaveBeenCalledWith(
      'live-session',
      'copilot',
      'C:\\repo',
      undefined,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      path.join(sessionDir, 'events.jsonl'),
      'live-session'
    );
    expect(sessionsDb.updateSessionGeneratedSummaryIfEmpty).toHaveBeenCalledWith(
      'live-session',
      'Live conversation'
    );
  });

  it('polls only the completed Copilot session until its delayed summary is available', async () => {
    vi.useFakeTimers();
    mocks.get
      .mockReturnValueOnce({
        id: 'live-session',
        cwd: 'C:\\repo',
        summary: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      })
      .mockReturnValueOnce({
        id: 'live-session',
        cwd: 'C:\\repo',
        summary: 'Native delayed title',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:20.000Z',
      });

    const resultPromise = waitForCopilotSessionSummary('live-session', {
      maxWaitMs: 20,
      pollIntervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toBe('live-session');
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.all).not.toHaveBeenCalled();
    expect(sessionsDb.updateSessionGeneratedSummaryIfEmpty).toHaveBeenCalledOnce();
    expect(sessionsDb.updateSessionGeneratedSummaryIfEmpty).toHaveBeenCalledWith(
      'live-session',
      'Native delayed title'
    );
  });
});
