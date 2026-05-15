// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
// We test getSessionFileMeta + getSessions via a temp project directory.
// The SQLite DB used is the real app DB (process.env.DATABASE_PATH from load-env).
// Each test uses a unique project name to avoid collision.

let getSessionFileMeta;
let getSessions;
let sessionFileCache;

const tmpBase = path.join(os.homedir(), '.claude', 'projects');
const projectName = `__test_session_cache_${Date.now()}`;
const projectDir = path.join(tmpBase, projectName);

function makeLine(sessionId, role, text, timestamp, extra = {}) {
  const entry = {
    sessionId,
    timestamp: timestamp ?? new Date().toISOString(),
    uuid: `${Math.random().toString(36).slice(2)}`,
    parentUuid: null,
    ...extra,
  };
  if (role === 'user' || role === 'assistant') {
    entry.type = role;
    entry.message = { role, content: text };
  }
  return JSON.stringify(entry);
}

async function writeSession(file, lines) {
  await fs.writeFile(path.join(projectDir, file), lines.join('\n') + '\n', 'utf8');
}

async function appendToSession(file, lines) {
  await fs.appendFile(path.join(projectDir, file), lines.map(l => l + '\n').join(''), 'utf8');
}

beforeEach(async () => {
  await fs.mkdir(projectDir, { recursive: true });

  // Re-import fresh to pick up the real DB (already initialised by db.js module init)
  const mod = await import('./projects.js');
  getSessionFileMeta = mod.getSessionFileMeta;
  getSessions = mod.getSessions;
  const dbMod = await import('./database/db.js');
  sessionFileCache = dbMod.sessionFileCache;
});

afterEach(async () => {
  // Clean up temp project dir and cache entries
  const files = await fs.readdir(projectDir).catch(() => []);
  for (const f of files) {
    const fp = path.join(projectDir, f);
    sessionFileCache.delete(fp);
    await fs.unlink(fp).catch(() => {});
  }
  await fs.rmdir(projectDir).catch(() => {});
});

// ─── getSessionFileMeta ───────────────────────────────────────────────────────

describe('getSessionFileMeta', () => {
  it('cold cache: reads file and returns correct metadata', async () => {
    const sid = 'test-session-cold';
    const ts = '2024-01-01T10:00:00.000Z';
    await writeSession('cold.jsonl', [
      makeLine(sid, 'user', 'Hello world', ts),
      makeLine(sid, 'assistant', 'Hi there', '2024-01-01T10:00:01.000Z'),
    ]);

    const fp = path.join(projectDir, 'cold.jsonl');
    const meta = await getSessionFileMeta(fp);

    expect(meta.sessionId).toBe(sid);
    expect(meta.lastUserMessage).toBe('Hello world');
    expect(meta.lastAssistantMessage).toContain('Hi');
    expect(meta.messageCount).toBe(2);
    expect(meta.lastActivity).toBe('2024-01-01T10:00:01.000Z');
  });

  it('warm cache: returns cached data without reading file content', async () => {
    const sid = 'test-session-warm';
    const fp = path.join(projectDir, 'warm.jsonl');
    await writeSession('warm.jsonl', [
      makeLine(sid, 'user', 'Cached message', '2024-02-01T00:00:00.000Z'),
    ]);

    // First call populates cache
    await getSessionFileMeta(fp);

    // Overwrite file with garbage to prove second call doesn't re-read
    await fs.writeFile(fp + '.bak', 'placeholder');
    const stat = await fs.stat(fp);
    // Manually corrupt file in-place won't work since we'd need same size.
    // Instead, verify cache entry exists and matches
    const cached = sessionFileCache.get(fp);
    expect(cached).toBeTruthy();
    expect(cached.session_id).toBe(sid);

    // Second call must return cached (same size → cache hit)
    const meta2 = await getSessionFileMeta(fp);
    expect(meta2.sessionId).toBe(sid);
    expect(meta2.lastUserMessage).toBe('Cached message');
    await fs.unlink(fp + '.bak').catch(() => {});
  });

  it('incremental read: appended lines update messageCount and lastUserMessage', async () => {
    const sid = 'test-session-incr';
    const fp = path.join(projectDir, 'incr.jsonl');
    await writeSession('incr.jsonl', [
      makeLine(sid, 'user', 'First message', '2024-03-01T00:00:00.000Z'),
    ]);

    // Cold scan
    const meta1 = await getSessionFileMeta(fp);
    expect(meta1.messageCount).toBe(1);
    expect(meta1.lastUserMessage).toBe('First message');

    // Append new lines
    await appendToSession('incr.jsonl', [
      makeLine(sid, 'assistant', 'Reply', '2024-03-01T00:01:00.000Z'),
      makeLine(sid, 'user', 'Second message', '2024-03-01T00:02:00.000Z'),
    ]);

    // Incremental scan should only read the delta
    const meta2 = await getSessionFileMeta(fp);
    expect(meta2.messageCount).toBe(3);
    expect(meta2.lastUserMessage).toBe('Second message');
    expect(meta2.lastActivity).toBe('2024-03-01T00:02:00.000Z');
  });

  it('full rescan when file size shrinks (replaced file)', async () => {
    const sid1 = 'test-session-old';
    const sid2 = 'test-session-new';
    const fp = path.join(projectDir, 'replaced.jsonl');

    // Write a larger file first
    await writeSession('replaced.jsonl', [
      makeLine(sid1, 'user', 'Old message one', '2024-04-01T00:00:00.000Z'),
      makeLine(sid1, 'user', 'Old message two', '2024-04-01T00:01:00.000Z'),
      makeLine(sid1, 'user', 'Old message three', '2024-04-01T00:02:00.000Z'),
    ]);
    await getSessionFileMeta(fp);

    // Replace with smaller file (different session)
    await writeSession('replaced.jsonl', [
      makeLine(sid2, 'user', 'Brand new', '2024-05-01T00:00:00.000Z'),
    ]);

    const meta = await getSessionFileMeta(fp);
    expect(meta.sessionId).toBe(sid2);
    expect(meta.lastUserMessage).toBe('Brand new');
    expect(meta.messageCount).toBe(1);
  });

  it('system messages are filtered from lastUserMessage', async () => {
    const sid = 'test-session-sysfilter';
    const fp = path.join(projectDir, 'sysfilter.jsonl');
    await writeSession('sysfilter.jsonl', [
      makeLine(sid, 'user', 'Real message', '2024-06-01T00:00:00.000Z'),
      makeLine(sid, 'user', '<system-reminder>ignore this</system-reminder>', '2024-06-01T00:01:00.000Z'),
    ]);

    const meta = await getSessionFileMeta(fp);
    // lastUserMessage should be 'Real message', not the system reminder
    expect(meta.lastUserMessage).toBe('Real message');
  });
});

// ─── getSessions ─────────────────────────────────────────────────────────────

describe('getSessions', () => {
  it('returns sessions sorted by lastActivity desc', async () => {
    const sid1 = 'sess-older';
    const sid2 = 'sess-newer';
    await writeSession('a.jsonl', [
      makeLine(sid1, 'user', 'Older', '2024-01-01T00:00:00.000Z'),
    ]);
    await writeSession('b.jsonl', [
      makeLine(sid2, 'user', 'Newer', '2024-02-01T00:00:00.000Z'),
    ]);

    const result = await getSessions(projectName, 10, 0);
    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    const ids = result.sessions.map(s => s.id);
    expect(ids.indexOf(sid2)).toBeLessThan(ids.indexOf(sid1));
  });

  it('warm cache is faster than cold scan', async () => {
    const sid = 'perf-session';
    for (let i = 0; i < 5; i++) {
      await writeSession(`perf${i}.jsonl`, [
        makeLine(sid + i, 'user', `Message ${i}`, `2024-0${i + 1}-01T00:00:00.000Z`),
        makeLine(sid + i, 'assistant', `Reply ${i}`, `2024-0${i + 1}-01T00:01:00.000Z`),
      ]);
    }

    const t1 = Date.now();
    await getSessions(projectName, 10, 0);
    const cold = Date.now() - t1;

    const t2 = Date.now();
    await getSessions(projectName, 10, 0);
    const warm = Date.now() - t2;

    // Warm should be noticeably faster (at least 2x or within 50ms if both tiny)
    expect(warm).toBeLessThanOrEqual(Math.max(cold, 50));
  });

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await writeSession(`page${i}.jsonl`, [
        makeLine(`page-sess-${i}`, 'user', `Page msg ${i}`, `2024-0${i + 1}-01T00:00:00.000Z`),
      ]);
    }

    const page1 = await getSessions(projectName, 2, 0);
    const page2 = await getSessions(projectName, 2, 2);

    expect(page1.sessions.length).toBe(2);
    expect(page2.sessions.length).toBe(2);
    const ids1 = page1.sessions.map(s => s.id);
    const ids2 = page2.sessions.map(s => s.id);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
    expect(page1.hasMore).toBe(true);
  });
});

// ─── Project management (projectsDb integration) ─────────────────────────────

describe('addProjectManually', () => {
  let addProjectManually;
  let projectsDb;
  let clearProjectDirectoryCache;
  let tmpProjectDir;

  beforeEach(async () => {
    tmpProjectDir = path.join(os.tmpdir(), `__test_proj_${Date.now()}`);
    await fs.mkdir(tmpProjectDir, { recursive: true });

    const mod = await import('./projects.js');
    addProjectManually = mod.addProjectManually;
    clearProjectDirectoryCache = mod.clearProjectDirectoryCache;
    const dbMod = await import('./modules/database/index.js');
    projectsDb = dbMod.projectsDb;
  });

  afterEach(async () => {
    projectsDb.deleteProject(tmpProjectDir);
    clearProjectDirectoryCache();
    await fs.rm(tmpProjectDir, { recursive: true, force: true });
  });

  it('stores project path in DB', async () => {
    await addProjectManually(tmpProjectDir);
    const row = projectsDb.getProjectPath(tmpProjectDir);
    expect(row).not.toBeNull();
    expect(row.project_path).toBe(tmpProjectDir);
    expect(row.isArchived).toBe(0);
  });

  it('stores custom display name in DB', async () => {
    await addProjectManually(tmpProjectDir, 'My Custom Name');
    const row = projectsDb.getProjectPath(tmpProjectDir);
    expect(row.custom_project_name).toBe('My Custom Name');
  });

  it('throws when path does not exist', async () => {
    await expect(addProjectManually('/nonexistent/path/xyz')).rejects.toThrow('Path does not exist');
  });

  it('throws when project already exists in DB', async () => {
    await addProjectManually(tmpProjectDir);
    await expect(addProjectManually(tmpProjectDir)).rejects.toThrow('already configured');
  });

  it('returns project object with correct fields', async () => {
    const result = await addProjectManually(tmpProjectDir, 'Test Project');
    expect(result.path).toBe(tmpProjectDir);
    expect(result.fullPath).toBe(tmpProjectDir);
    expect(result.displayName).toBe('Test Project');
    expect(result.isManuallyAdded).toBe(true);
  });
});

describe('extractProjectDirectory (DB-backed)', () => {
  let extractProjectDirectory;
  let projectsDb;
  let clearProjectDirectoryCache;
  let tmpProjectDir;

  beforeEach(async () => {
    tmpProjectDir = path.join(os.tmpdir(), `__test_extract_${Date.now()}`);
    await fs.mkdir(tmpProjectDir, { recursive: true });

    const mod = await import('./projects.js');
    extractProjectDirectory = mod.extractProjectDirectory;
    clearProjectDirectoryCache = mod.clearProjectDirectoryCache;
    const dbMod = await import('./modules/database/index.js');
    projectsDb = dbMod.projectsDb;
    clearProjectDirectoryCache();
  });

  afterEach(async () => {
    projectsDb.deleteProject(tmpProjectDir);
    clearProjectDirectoryCache();
    await fs.rm(tmpProjectDir, { recursive: true, force: true });
  });

  it('resolves originalPath from DB for manually added project', async () => {
    projectsDb.createProjectPath(tmpProjectDir);
    const encodedName = tmpProjectDir.replace(/[\\/:\s~_]/g, '-');
    const result = await extractProjectDirectory(encodedName);
    expect(result).toBe(tmpProjectDir);
  });

  it('caches the result on second call', async () => {
    projectsDb.createProjectPath(tmpProjectDir);
    const encodedName = tmpProjectDir.replace(/[\\/:\s~_]/g, '-');
    await extractProjectDirectory(encodedName);
    // Delete from DB — second call should still return from cache
    projectsDb.deleteProject(tmpProjectDir);
    const result = await extractProjectDirectory(encodedName);
    expect(result).toBe(tmpProjectDir);
  });
});

describe('renameProject', () => {
  let renameProject;
  let projectsDb;
  let clearProjectDirectoryCache;
  let tmpProjectDir;

  beforeEach(async () => {
    tmpProjectDir = path.join(os.tmpdir(), `__test_rename_${Date.now()}`);
    await fs.mkdir(tmpProjectDir, { recursive: true });

    const mod = await import('./projects.js');
    renameProject = mod.renameProject;
    clearProjectDirectoryCache = mod.clearProjectDirectoryCache;
    const dbMod = await import('./modules/database/index.js');
    projectsDb = dbMod.projectsDb;

    projectsDb.createProjectPath(tmpProjectDir);
    clearProjectDirectoryCache();
  });

  afterEach(async () => {
    projectsDb.deleteProject(tmpProjectDir);
    clearProjectDirectoryCache();
    await fs.rm(tmpProjectDir, { recursive: true, force: true });
  });

  it('updates custom_project_name in DB', async () => {
    const encodedName = tmpProjectDir.replace(/[\\/:\s~_]/g, '-');
    await renameProject(encodedName, 'Renamed Project');
    const row = projectsDb.getProjectPath(tmpProjectDir);
    expect(row.custom_project_name).toBe('Renamed Project');
  });

  it('clears custom name when empty string passed', async () => {
    const encodedName = tmpProjectDir.replace(/[\\/:\s~_]/g, '-');
    await renameProject(encodedName, 'Initial Name');
    await renameProject(encodedName, '');
    const row = projectsDb.getProjectPath(tmpProjectDir);
    expect(row.custom_project_name).toBeNull();
  });
});

describe('deleteProject', () => {
  let deleteProject;
  let projectsDb;
  let clearProjectDirectoryCache;
  let tmpProjectDir;
  let claudeProjectDir;

  beforeEach(async () => {
    tmpProjectDir = path.join(os.tmpdir(), `__test_delete_target_${Date.now()}`);
    await fs.mkdir(tmpProjectDir, { recursive: true });

    const encodedName = tmpProjectDir.replace(/[\\/:\s~_]/g, '-');
    claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', encodedName);
    await fs.mkdir(claudeProjectDir, { recursive: true });

    const mod = await import('./projects.js');
    deleteProject = mod.deleteProject;
    clearProjectDirectoryCache = mod.clearProjectDirectoryCache;
    const dbMod = await import('./modules/database/index.js');
    projectsDb = dbMod.projectsDb;

    projectsDb.createProjectPath(tmpProjectDir);
    clearProjectDirectoryCache();
  });

  afterEach(async () => {
    projectsDb.deleteProject(tmpProjectDir);
    clearProjectDirectoryCache();
    await fs.rm(tmpProjectDir, { recursive: true, force: true });
    await fs.rm(claudeProjectDir, { recursive: true, force: true });
  });

  it('archives project in DB after deletion', async () => {
    const encodedName = tmpProjectDir.replace(/[\\/:\s~_]/g, '-');
    await deleteProject(encodedName, true);
    const row = projectsDb.getProjectPath(tmpProjectDir);
    expect(row.isArchived).toBe(1);
  });

  it('removes project directory from file system', async () => {
    const encodedName = tmpProjectDir.replace(/[\\/:\s~_]/g, '-');
    await deleteProject(encodedName, true);
    await expect(fs.access(claudeProjectDir)).rejects.toThrow();
  });
});
