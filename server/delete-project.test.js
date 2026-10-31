// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// The DB must be redirected BEFORE any server module is imported: server/database/db.js
// opens the connection (and runs migrations) as a side effect of being imported, and
// server/modules/database/connection.js resolves DATABASE_PATH lazily on first use.
// Never point this at the live ~/.cloudcli/auth.db.
const originalDatabasePath = process.env.DATABASE_PATH;
const dbPath = path.join(
  os.tmpdir(),
  `ccui-delete-project-${Date.now()}-${process.pid}.db`,
);
process.env.DATABASE_PATH = dbPath;

const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// The project the session is indexed under. It lives in os.tmpdir() and the test
// NEVER creates a transcript file for it: the session row is inserted directly with
// sessionsDb.createSession(). Keeping every fixture out of ~/.claude/projects matters
// even though this test uses an isolated DATABASE_PATH — the user's running app watches
// that tree and would index a fixture .jsonl into the LIVE database.
const indexedProjectPath = path.join(os.tmpdir(), `ccui-delete-target-${uniqueSuffix}`);
const sessionId = `test-delete-session-${uniqueSuffix}`;
const transcriptPath = path.join(indexedProjectPath, `${sessionId}.jsonl`);

// extractProjectDirectory() resolves a project by matching pathToClaudeProjectName()
// against the registered project paths, so the name passed to deleteProject() must be
// the encoded Claude directory name (same rule as server/projects.js).
const claudeProjectName = indexedProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
// deleteProject() removes this directory. It is created EMPTY on purpose: no .jsonl means
// the running app's watcher ignores it, so the test cannot leak rows into the live DB.
const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', claudeProjectName);

const liveProjectsRoot = path.join(os.homedir(), '.claude', 'projects');

let countProjectSessions;
let isProjectEmpty;
let deleteProject;
let closeConnection;

beforeAll(async () => {
  // Guard: no fixture may live under the watched ~/.claude/projects tree.
  expect(indexedProjectPath.startsWith(liveProjectsRoot)).toBe(false);
  expect(transcriptPath.startsWith(liveProjectsRoot)).toBe(false);

  await fs.mkdir(claudeProjectDir, { recursive: true });

  const projectsModule = await import('./projects.js');
  countProjectSessions = projectsModule.countProjectSessions;
  isProjectEmpty = projectsModule.isProjectEmpty;
  deleteProject = projectsModule.deleteProject;

  const { sessionsDb } = await import('./modules/database/index.js');
  sessionsDb.createSession(
    sessionId,
    'claude',
    indexedProjectPath,
    'delete-guard fixture',
    new Date().toISOString(),
    new Date().toISOString(),
    transcriptPath,
  );

  const connectionModule = await import('./modules/database/connection.js');
  closeConnection = connectionModule.closeConnection;
});

afterAll(async () => {
  await fs.rm(claudeProjectDir, { recursive: true, force: true }).catch(() => {});
  try {
    closeConnection?.();
  } catch {
    // connection may already be closed
  }
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(`${dbPath}${suffix}`, { force: true }).catch(() => {});
  }
  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }
});

describe('project delete guard (server-authoritative session count)', () => {
  it('counts sessions even though no transcript file exists', async () => {
    expect(process.env.DATABASE_PATH).toBe(dbPath);
    expect(await countProjectSessions(claudeProjectName)).toBeGreaterThanOrEqual(1);
  });

  it('reports the project as non-empty', async () => {
    expect(await isProjectEmpty(claudeProjectName)).toBe(false);
  });

  it('refuses a non-forced delete with PROJECT_HAS_SESSIONS', async () => {
    let thrown;
    try {
      await deleteProject(claudeProjectName, false);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeTruthy();
    expect(thrown).toMatchObject({
      code: 'PROJECT_HAS_SESSIONS',
      message: 'Cannot delete project with existing sessions',
    });
    expect(typeof thrown.sessionCount).toBe('number');
    expect(thrown.sessionCount).toBeGreaterThanOrEqual(1);

    // The guard must not have removed anything.
    await expect(fs.access(claudeProjectDir)).resolves.toBeUndefined();
  });

  it('fails closed when the session count cannot be determined', async () => {
    const { sessionsDb } = await import('./modules/database/index.js');
    const getRowsSpy = vi
      .spyOn(sessionsDb, 'getSessionsByProjectPath')
      .mockImplementation(() => {
        throw new Error('simulated DB failure');
      });

    try {
      // getSessions turns lookup failures into total 0 for normal callers; the delete
      // guard asks for strict mode so an unreadable index surfaces as null, never as
      // "this project is empty".
      await expect(countProjectSessions(claudeProjectName)).resolves.toBeNull();
      await expect(isProjectEmpty(claudeProjectName)).resolves.toBe(false);
      await expect(deleteProject(claudeProjectName, true)).rejects.toMatchObject({
        code: 'PROJECT_HAS_SESSIONS',
      });

      // Nothing may have been removed while the count was unknown.
      await expect(fs.access(claudeProjectDir)).resolves.toBeUndefined();
    } finally {
      getRowsSpy.mockRestore();
    }
  });

  it('deletes the project when forced', async () => {
    await expect(deleteProject(claudeProjectName, true)).resolves.toBe(true);
    await expect(fs.access(claudeProjectDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
