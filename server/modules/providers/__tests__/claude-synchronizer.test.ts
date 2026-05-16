import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock sessionsDb
vi.mock('@/modules/database/index.js', () => ({
  sessionsDb: {
    createSession: vi.fn(),
  },
  projectsDb: {
    createProjectPath: vi.fn(),
    updateClaudeDirName: vi.fn(),
  },
}));

import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import { claudeSessionSynchronizer } from '../list/claude/claude-session-synchronizer.provider.js';

describe('claudeSessionSynchronizer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `claude-sync-test-${Date.now()}`);
    await mkdir(join(tmpDir, 'projects', 'Users-foo-bar-myproject'), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('synchronizeFile extracts sessionId and projectPath from first JSONL line', async () => {
    const jsonlPath = join(tmpDir, 'projects', 'Users-foo-bar-myproject', 'session-abc.jsonl');
    await writeFile(
      jsonlPath,
      '{"sessionId":"session-abc","cwd":"/home/foo/bar/myproject","type":"user","message":{"role":"user","content":"hello"}}\n'
    );

    const result = await claudeSessionSynchronizer.synchronizeFile(jsonlPath);

    expect(result).toBe('session-abc');
    expect(sessionsDb.createSession).toHaveBeenCalledWith(
      'session-abc',
      'claude',
      '/home/foo/bar/myproject',
      undefined,
      expect.any(String),
      expect.any(String),
      jsonlPath
    );
  });

  it('synchronizeFile returns null for JSONL without sessionId', async () => {
    const jsonlPath = join(tmpDir, 'projects', 'Users-foo-bar-myproject', 'bad.jsonl');
    await writeFile(jsonlPath, '{"type":"user","message":{"role":"user","content":"no session id"}}\n');

    const result = await claudeSessionSynchronizer.synchronizeFile(jsonlPath);
    expect(result).toBeNull();
    expect(sessionsDb.createSession).not.toHaveBeenCalled();
  });

  it('synchronize processes all .jsonl files when since is null', async () => {
    const dir = join(tmpDir, 'projects', 'Users-foo-bar-myproject');
    await writeFile(
      join(dir, 'session1.jsonl'),
      '{"sessionId":"s1","cwd":"/foo","type":"user","message":{"role":"user","content":"x"}}\n'
    );
    await writeFile(
      join(dir, 'session2.jsonl'),
      '{"sessionId":"s2","cwd":"/foo","type":"user","message":{"role":"user","content":"y"}}\n'
    );

    // Override watch paths to use tmpDir
    const original = claudeSessionSynchronizer.watchPaths;
    (claudeSessionSynchronizer as any).watchPaths = [join(tmpDir, 'projects')];

    const count = await claudeSessionSynchronizer.synchronize(null);
    expect(count).toBe(2);
    expect(sessionsDb.createSession).toHaveBeenCalledTimes(2);

    (claudeSessionSynchronizer as any).watchPaths = original;
  });
});
