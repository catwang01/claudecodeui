# DB-First Session Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace filesystem-scan architecture with DB-first session discovery: synchronizer services keep `sessions`/`projects` tables up-to-date; `getProjects()` and `getSessions()` read from DB instead of scanning disk; chokidar watcher updates DB on every file change.

**Architecture:** New TypeScript modules under `server/modules/providers/` handle per-provider JSONL synchronization and chokidar watching. `projects.js` query functions (`getProjects`, `getSessions`) are refactored to use DB as the primary index, calling `getSessionFileMeta()` only for rich content metadata (still cached in `session_file_cache`). All local features (isAutoDoc, hiddenFromRecents, readState) are preserved.

**Tech Stack:** TypeScript + better-sqlite3, chokidar (already installed), vitest for tests, Node.js fs/promises

---

## File Map

**New files:**
- `server/modules/providers/types.ts` — `ISessionSynchronizer` interface
- `server/modules/providers/utils.ts` — shared JSONL helpers: `readFileTimestamps`, `readFirstJsonlLine`, `findFilesModifiedAfter`
- `server/modules/providers/registry.ts` — `ALL_SYNCHRONIZERS` array (avoids circular deps)
- `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`
- `server/modules/providers/list/cursor/cursor-session-synchronizer.provider.ts`
- `server/modules/providers/list/codex/codex-session-synchronizer.provider.ts`
- `server/modules/providers/list/gemini/gemini-session-synchronizer.provider.ts`
- `server/modules/providers/list/opencode/opencode-session-synchronizer.provider.ts`
- `server/modules/providers/services/session-synchronizer.service.ts`
- `server/modules/providers/services/sessions-watcher.service.ts`
- `server/modules/providers/index.ts`
- `server/modules/providers/__tests__/utils.test.ts`
- `server/modules/providers/__tests__/claude-synchronizer.test.ts`
- `server/modules/providers/__tests__/session-synchronizer.service.test.ts`

**Modified files:**
- `vite.config.js` — add `server/**/*.test.ts` to vitest includes
- `server/modules/database/schema.ts` — fix `scan_state` NOT NULL; add `claude_dir_name` to `projects`
- `server/modules/database/repositories/projects.db.ts` — add `updateClaudeDirName()` method
- `server/shared/types.ts` — add `claude_dir_name` to `ProjectRepositoryRow`
- `server/projects.js` — export `getSessionFileMeta`; rewrite `getSessions()` and `getProjects()` to use DB
- `server/index.js` — replace `setupProjectsWatcher()` + `backfill` with `initializeSessionsWatcher()`

**Deleted files:**
- `server/modules/database/backfill.ts` — replaced by `synchronizeSessions()` at startup

---

## Task 1: Prerequisites — Vitest Config + Schema Fixes

**Files:**
- Modify: `vite.config.js`
- Modify: `server/modules/database/schema.ts`
- Modify: `server/shared/types.ts`
- Modify: `server/modules/database/repositories/projects.db.ts`

- [ ] **Step 1: Add TypeScript test support to vitest**

In `vite.config.js`, change:
```js
include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.js'],
environmentMatchGlobs: [
  ['server/**/*.test.js', 'node'],
],
```
to:
```js
include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.js', 'server/**/*.test.ts'],
environmentMatchGlobs: [
  ['server/**/*.test.js', 'node'],
  ['server/**/*.test.ts', 'node'],
],
```

- [ ] **Step 2: Fix `scan_state` schema (allow NULL)**

In `server/modules/database/schema.ts`, change:
```ts
export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY NOT NULL,
  last_scanned_at TIMESTAMP NOT NULL
);`;
```
to:
```ts
export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);`;
```

- [ ] **Step 3: Add `claude_dir_name` to `projects` schema**

In `server/modules/database/schema.ts`, change:
```ts
export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  project_path TEXT NOT NULL UNIQUE,
  custom_project_name TEXT DEFAULT NULL,
  isStarred BOOLEAN DEFAULT 0,
  isArchived BOOLEAN DEFAULT 0
);`;
```
to:
```ts
export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  project_path TEXT NOT NULL UNIQUE,
  custom_project_name TEXT DEFAULT NULL,
  claude_dir_name TEXT DEFAULT NULL,
  isStarred BOOLEAN DEFAULT 0,
  isArchived BOOLEAN DEFAULT 0
);`;
```

Also add the migration to add the column to existing DBs. In `server/modules/database/migrations.ts`, find the `runMigrations` function and add:
```ts
// Add claude_dir_name to projects if it doesn't exist
try {
  db.prepare('ALTER TABLE projects ADD COLUMN claude_dir_name TEXT DEFAULT NULL').run();
} catch { /* column already exists */ }
// Fix scan_state to allow NULL (recreate if schema differs — SQLite can't ALTER constraints)
```

- [ ] **Step 4: Update `ProjectRepositoryRow` type**

In `server/shared/types.ts`, find `ProjectRepositoryRow` and add the new field:
```ts
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  claude_dir_name: string | null;
  isStarred: boolean;
  isArchived: boolean;
};
```

- [ ] **Step 5: Add `updateClaudeDirName` to projectsDb**

In `server/modules/database/repositories/projects.db.ts`, add after `updateProjectCustomName`:
```ts
updateClaudeDirName(projectPath: string, claudeDirName: string): void {
  const db = getConnection();
  db.prepare(
    'UPDATE projects SET claude_dir_name = ? WHERE project_path = ?'
  ).run(claudeDirName, normalizeProjectPath(projectPath));
},
```

Also update the SELECT queries in `getProjectPath`, `getProjectById`, `getAllProjects` to include `claude_dir_name`:
```ts
// change each SELECT to:
'SELECT project_id, project_path, custom_project_name, claude_dir_name, isStarred, isArchived FROM projects WHERE ...'
```

- [ ] **Step 6: Run type check and tests**

```bash
npm run typecheck && npm test
```
Expected: all 75 tests pass, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add vite.config.js server/modules/database/schema.ts server/modules/database/repositories/projects.db.ts server/shared/types.ts server/modules/database/migrations.ts
git commit -m "feat(db): add claude_dir_name to projects, fix scan_state schema, add TS test support"
```

---

## Task 2: Provider Shared Utilities

**Files:**
- Create: `server/modules/providers/types.ts`
- Create: `server/modules/providers/utils.ts`
- Create: `server/modules/providers/__tests__/utils.test.ts`

- [ ] **Step 1: Write failing tests for utils**

Create `server/modules/providers/__tests__/utils.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFirstJsonlLine, findFilesModifiedAfter, readFileTimestamps } from '../utils.js';

describe('readFirstJsonlLine', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts sessionId and cwd from first valid line', async () => {
    const filePath = join(tmpDir, 'session.jsonl');
    await writeFile(filePath, '{"sessionId":"abc-123","cwd":"/home/user/project","type":"user"}\n{"type":"assistant"}\n');

    const result = await readFirstJsonlLine(filePath, (data: unknown) => {
      const d = data as Record<string, unknown>;
      if (typeof d.sessionId !== 'string') return null;
      return { sessionId: d.sessionId, projectPath: d.cwd as string };
    });

    expect(result).toEqual({ sessionId: 'abc-123', projectPath: '/home/user/project' });
  });

  it('returns null for empty file', async () => {
    const filePath = join(tmpDir, 'empty.jsonl');
    await writeFile(filePath, '');
    const result = await readFirstJsonlLine(filePath, () => null);
    expect(result).toBeNull();
  });

  it('returns null if parse fn returns null', async () => {
    const filePath = join(tmpDir, 'no-match.jsonl');
    await writeFile(filePath, '{"type":"unknown"}\n');
    const result = await readFirstJsonlLine(filePath, () => null);
    expect(result).toBeNull();
  });
});

describe('findFilesModifiedAfter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('finds all .jsonl files when since is null', async () => {
    await writeFile(join(tmpDir, 'a.jsonl'), '');
    await writeFile(join(tmpDir, 'b.jsonl'), '');
    await writeFile(join(tmpDir, 'c.txt'), '');

    const files = await findFilesModifiedAfter(tmpDir, '.jsonl', null);
    expect(files).toHaveLength(2);
    expect(files.every(f => f.endsWith('.jsonl'))).toBe(true);
  });

  it('filters by modification time when since is provided', async () => {
    const past = new Date(Date.now() + 5000); // future date
    await writeFile(join(tmpDir, 'old.jsonl'), '');

    const files = await findFilesModifiedAfter(tmpDir, '.jsonl', past);
    expect(files).toHaveLength(0);
  });
});

describe('readFileTimestamps', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns ISO timestamp strings', async () => {
    const filePath = join(tmpDir, 'test.jsonl');
    await writeFile(filePath, 'hello');

    const ts = await readFileTimestamps(filePath);
    expect(ts.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ts.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (files not yet created)**

```bash
npm test -- server/modules/providers/__tests__/utils.test.ts
```
Expected: FAIL with "Cannot find module '../utils.js'"

- [ ] **Step 3: Create types.ts**

Create `server/modules/providers/types.ts`:
```ts
export interface ISessionSynchronizer {
  provider: string;
  watchPaths: string[];
  synchronize(since: Date | null): Promise<number>;
  synchronizeFile(filePath: string): Promise<string | null>;
}
```

- [ ] **Step 4: Create utils.ts**

Create `server/modules/providers/utils.ts`:
```ts
import { open, stat, readdir } from 'fs/promises';
import path from 'path';

export async function readFileTimestamps(
  filePath: string
): Promise<{ createdAt: string; updatedAt: string }> {
  const s = await stat(filePath);
  return {
    createdAt: s.birthtime.toISOString(),
    updatedAt: s.mtime.toISOString(),
  };
}

export async function readFirstJsonlLine<T>(
  filePath: string,
  parse: (data: unknown) => T | null
): Promise<T | null> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = parse(JSON.parse(trimmed));
        if (parsed !== null) return parsed;
      } catch { /* skip malformed */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export async function findFilesModifiedAfter(
  rootDir: string,
  ext: string,
  since: Date | null
): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          await walk(fullPath);
        } else if (entry.endsWith(ext)) {
          if (!since || s.mtime > since) {
            result.push(fullPath);
          }
        }
      } catch { /* skip inaccessible */ }
    }
  }

  await walk(rootDir);
  return result;
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
npm test -- server/modules/providers/__tests__/utils.test.ts
```
Expected: PASS (3 describe blocks, all green)

- [ ] **Step 6: Commit**

```bash
git add server/modules/providers/types.ts server/modules/providers/utils.ts server/modules/providers/__tests__/utils.test.ts
git commit -m "feat(providers): add shared provider utilities and ISessionSynchronizer interface"
```

---

## Task 3: Claude Session Synchronizer

**Files:**
- Create: `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`
- Create: `server/modules/providers/__tests__/claude-synchronizer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/modules/providers/__tests__/claude-synchronizer.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test -- server/modules/providers/__tests__/claude-synchronizer.test.ts
```
Expected: FAIL with "Cannot find module '../list/claude/claude-session-synchronizer.provider.js'"

- [ ] **Step 3: Create Claude synchronizer**

Create `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`:
```ts
import path from 'path';
import os from 'os';
import { readFileTimestamps, readFirstJsonlLine, findFilesModifiedAfter } from '../../utils.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import type { ISessionSynchronizer } from '../../types.js';

const CLAUDE_HOME = path.join(os.homedir(), '.claude');

export const claudeSessionSynchronizer: ISessionSynchronizer = {
  provider: 'claude',

  get watchPaths() {
    return [path.join(CLAUDE_HOME, 'projects')];
  },

  async synchronize(since: Date | null): Promise<number> {
    const projectsDir = path.join(CLAUDE_HOME, 'projects');
    let files: string[];
    try {
      files = await findFilesModifiedAfter(projectsDir, '.jsonl', since);
    } catch {
      return 0;
    }

    let count = 0;
    for (const filePath of files) {
      // Skip agent sub-session files
      if (path.basename(filePath).startsWith('agent-')) continue;
      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) count++;
    }
    return count;
  },

  async synchronizeFile(filePath: string): Promise<string | null> {
    const parsed = await readFirstJsonlLine(filePath, (data) => {
      const d = data as Record<string, unknown>;
      const sessionId = typeof d.sessionId === 'string' ? d.sessionId : null;
      const projectPath = typeof d.cwd === 'string' ? d.cwd : null;
      if (!sessionId || !projectPath) return null;
      return { sessionId, projectPath };
    });

    if (!parsed) return null;

    const timestamps = await readFileTimestamps(filePath).catch(() => ({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    // The Claude directory name is the parent directory of the .jsonl file
    const claudeDirName = path.basename(path.dirname(filePath));

    // Ensure project entry exists and record the claude dir name
    projectsDb.createProjectPath(parsed.projectPath);
    projectsDb.updateClaudeDirName(parsed.projectPath, claudeDirName);

    sessionsDb.createSession(
      parsed.sessionId,
      'claude',
      parsed.projectPath,
      undefined,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    return parsed.sessionId;
  },
};
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test -- server/modules/providers/__tests__/claude-synchronizer.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/modules/providers/list/claude/ server/modules/providers/__tests__/claude-synchronizer.test.ts
git commit -m "feat(providers): implement Claude session synchronizer"
```

---

## Task 4: Cursor, Codex, Gemini, OpenCode Synchronizers

**Files:**
- Create: `server/modules/providers/list/cursor/cursor-session-synchronizer.provider.ts`
- Create: `server/modules/providers/list/codex/codex-session-synchronizer.provider.ts`
- Create: `server/modules/providers/list/gemini/gemini-session-synchronizer.provider.ts`
- Create: `server/modules/providers/list/opencode/opencode-session-synchronizer.provider.ts`
- Create: `server/modules/providers/registry.ts`

- [ ] **Step 1: Create Cursor synchronizer**

Create `server/modules/providers/list/cursor/cursor-session-synchronizer.provider.ts`:
```ts
import path from 'path';
import os from 'os';
import { readFileTimestamps, readFirstJsonlLine, findFilesModifiedAfter } from '../../utils.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import type { ISessionSynchronizer } from '../../types.js';

const CURSOR_HOME = path.join(os.homedir(), '.cursor');

export const cursorSessionSynchronizer: ISessionSynchronizer = {
  provider: 'cursor',

  get watchPaths() {
    return [path.join(CURSOR_HOME, 'projects')];
  },

  async synchronize(since: Date | null): Promise<number> {
    const projectsDir = path.join(CURSOR_HOME, 'projects');
    let files: string[];
    try {
      files = await findFilesModifiedAfter(projectsDir, '.jsonl', since);
    } catch {
      return 0;
    }

    let count = 0;
    for (const filePath of files) {
      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) count++;
    }
    return count;
  },

  async synchronizeFile(filePath: string): Promise<string | null> {
    const parsed = await readFirstJsonlLine(filePath, (data) => {
      const d = data as Record<string, unknown>;
      const sessionId = typeof d.sessionId === 'string' ? d.sessionId : null;
      const projectPath = typeof d.cwd === 'string' ? d.cwd : null;
      if (!sessionId || !projectPath) return null;
      return { sessionId, projectPath };
    });

    if (!parsed) return null;

    const timestamps = await readFileTimestamps(filePath).catch(() => ({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    projectsDb.createProjectPath(parsed.projectPath);
    sessionsDb.createSession(
      parsed.sessionId,
      'cursor',
      parsed.projectPath,
      undefined,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    return parsed.sessionId;
  },
};
```

- [ ] **Step 2: Create Codex synchronizer**

Create `server/modules/providers/list/codex/codex-session-synchronizer.provider.ts`:
```ts
import path from 'path';
import os from 'os';
import { readFileTimestamps, findFilesModifiedAfter } from '../../utils.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import type { ISessionSynchronizer } from '../../types.js';
import { randomUUID } from 'node:crypto';

const CODEX_HOME = path.join(os.homedir(), '.codex');

export const codexSessionSynchronizer: ISessionSynchronizer = {
  provider: 'codex',

  get watchPaths() {
    return [path.join(CODEX_HOME, 'sessions')];
  },

  async synchronize(since: Date | null): Promise<number> {
    const sessionsDir = path.join(CODEX_HOME, 'sessions');
    let files: string[];
    try {
      files = await findFilesModifiedAfter(sessionsDir, '.jsonl', since);
    } catch {
      return 0;
    }

    let count = 0;
    for (const filePath of files) {
      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) count++;
    }
    return count;
  },

  async synchronizeFile(filePath: string): Promise<string | null> {
    // Codex JSONL files store session metadata differently;
    // use the file's parent directory name as the session ID
    const sessionId = path.basename(path.dirname(filePath)) || path.basename(filePath, '.jsonl');
    if (!sessionId) return null;

    const timestamps = await readFileTimestamps(filePath).catch(() => ({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    // Codex sessions live under ~/.codex/sessions/<projectHash>/
    // Project path is not easily extractable without reading the file
    // Use the directory path as a synthetic project path
    const projectPath = path.dirname(path.dirname(filePath));

    projectsDb.createProjectPath(projectPath);
    sessionsDb.createSession(
      sessionId,
      'codex',
      projectPath,
      undefined,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    return sessionId;
  },
};
```

- [ ] **Step 3: Create Gemini synchronizer**

Create `server/modules/providers/list/gemini/gemini-session-synchronizer.provider.ts`:
```ts
import path from 'path';
import os from 'os';
import { readFileTimestamps, readFirstJsonlLine, findFilesModifiedAfter } from '../../utils.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import type { ISessionSynchronizer } from '../../types.js';

const GEMINI_HOME = path.join(os.homedir(), '.gemini');

export const geminiSessionSynchronizer: ISessionSynchronizer = {
  provider: 'gemini',

  get watchPaths() {
    return [path.join(GEMINI_HOME, 'tmp')];
  },

  async synchronize(since: Date | null): Promise<number> {
    const tmpDir = path.join(GEMINI_HOME, 'tmp');
    let files: string[];
    try {
      files = [
        ...(await findFilesModifiedAfter(tmpDir, '.jsonl', since)),
        ...(await findFilesModifiedAfter(tmpDir, '.json', since)),
      ];
    } catch {
      return 0;
    }

    let count = 0;
    for (const filePath of files) {
      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) count++;
    }
    return count;
  },

  async synchronizeFile(filePath: string): Promise<string | null> {
    const parsed = await readFirstJsonlLine(filePath, (data) => {
      const d = data as Record<string, unknown>;
      const sessionId = typeof d.sessionId === 'string' ? d.sessionId : null;
      const projectPath = typeof d.cwd === 'string' ? d.cwd : null;
      if (!sessionId || !projectPath) return null;
      return { sessionId, projectPath };
    });

    if (!parsed) return null;

    const timestamps = await readFileTimestamps(filePath).catch(() => ({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    projectsDb.createProjectPath(parsed.projectPath);
    sessionsDb.createSession(
      parsed.sessionId,
      'gemini',
      parsed.projectPath,
      undefined,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    return parsed.sessionId;
  },
};
```

- [ ] **Step 4: Create OpenCode synchronizer**

Create `server/modules/providers/list/opencode/opencode-session-synchronizer.provider.ts`:
```ts
import path from 'path';
import os from 'os';
import { readFileTimestamps, readFirstJsonlLine, findFilesModifiedAfter } from '../../utils.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import type { ISessionSynchronizer } from '../../types.js';

const OPENCODE_HOME = path.join(os.homedir(), '.opencode');

export const opencodeSessionSynchronizer: ISessionSynchronizer = {
  provider: 'opencode',

  get watchPaths() {
    return [path.join(OPENCODE_HOME, 'sessions')];
  },

  async synchronize(since: Date | null): Promise<number> {
    const sessionsDir = path.join(OPENCODE_HOME, 'sessions');
    let files: string[];
    try {
      files = await findFilesModifiedAfter(sessionsDir, '.jsonl', since);
    } catch {
      return 0;
    }

    let count = 0;
    for (const filePath of files) {
      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) count++;
    }
    return count;
  },

  async synchronizeFile(filePath: string): Promise<string | null> {
    const parsed = await readFirstJsonlLine(filePath, (data) => {
      const d = data as Record<string, unknown>;
      const sessionId = typeof d.sessionId === 'string' ? d.sessionId
        : typeof d.id === 'string' ? d.id : null;
      const projectPath = typeof d.cwd === 'string' ? d.cwd
        : typeof d.workingDir === 'string' ? d.workingDir : null;
      if (!sessionId || !projectPath) return null;
      return { sessionId, projectPath };
    });

    if (!parsed) return null;

    const timestamps = await readFileTimestamps(filePath).catch(() => ({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    projectsDb.createProjectPath(parsed.projectPath);
    sessionsDb.createSession(
      parsed.sessionId,
      'opencode',
      parsed.projectPath,
      undefined,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    return parsed.sessionId;
  },
};
```

- [ ] **Step 5: Create registry.ts**

Create `server/modules/providers/registry.ts`:
```ts
import { claudeSessionSynchronizer } from './list/claude/claude-session-synchronizer.provider.js';
import { cursorSessionSynchronizer } from './list/cursor/cursor-session-synchronizer.provider.js';
import { codexSessionSynchronizer } from './list/codex/codex-session-synchronizer.provider.js';
import { geminiSessionSynchronizer } from './list/gemini/gemini-session-synchronizer.provider.js';
import { opencodeSessionSynchronizer } from './list/opencode/opencode-session-synchronizer.provider.js';
import type { ISessionSynchronizer } from './types.js';

export const ALL_SYNCHRONIZERS: ISessionSynchronizer[] = [
  claudeSessionSynchronizer,
  cursorSessionSynchronizer,
  codexSessionSynchronizer,
  geminiSessionSynchronizer,
  opencodeSessionSynchronizer,
];
```

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```
Expected: 0 type errors

- [ ] **Step 7: Commit**

```bash
git add server/modules/providers/list/ server/modules/providers/registry.ts
git commit -m "feat(providers): add Cursor, Codex, Gemini, OpenCode session synchronizers"
```

---

## Task 5: Session Synchronizer Service (Orchestrator)

**Files:**
- Create: `server/modules/providers/services/session-synchronizer.service.ts`
- Create: `server/modules/providers/__tests__/session-synchronizer.service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/modules/providers/__tests__/session-synchronizer.service.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/database/index.js', () => ({
  scanStateDb: {
    getLastScannedAt: vi.fn().mockReturnValue(null),
    updateLastScannedAt: vi.fn(),
  },
}));

vi.mock('../registry.js', () => ({
  ALL_SYNCHRONIZERS: [
    {
      provider: 'claude',
      watchPaths: [],
      synchronize: vi.fn().mockResolvedValue(3),
      synchronizeFile: vi.fn().mockResolvedValue('session-abc'),
    },
    {
      provider: 'cursor',
      watchPaths: [],
      synchronize: vi.fn().mockResolvedValue(1),
      synchronizeFile: vi.fn().mockResolvedValue(null),
    },
  ],
}));

import { scanStateDb } from '@/modules/database/index.js';
import { ALL_SYNCHRONIZERS } from '../registry.js';
import { sessionSynchronizerService } from '../services/session-synchronizer.service.js';

describe('sessionSynchronizerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('synchronizeSessions calls all providers with lastScanAt', async () => {
    const lastDate = new Date('2024-01-01');
    vi.mocked(scanStateDb.getLastScannedAt).mockReturnValue(lastDate);

    await sessionSynchronizerService.synchronizeSessions();

    expect(ALL_SYNCHRONIZERS[0].synchronize).toHaveBeenCalledWith(lastDate);
    expect(ALL_SYNCHRONIZERS[1].synchronize).toHaveBeenCalledWith(lastDate);
    expect(scanStateDb.updateLastScannedAt).toHaveBeenCalledOnce();
  });

  it('synchronizeSessions updates last scanned at even if one provider fails', async () => {
    vi.mocked((ALL_SYNCHRONIZERS[0] as any).synchronize).mockRejectedValue(new Error('oops'));

    await sessionSynchronizerService.synchronizeSessions();

    expect(scanStateDb.updateLastScannedAt).toHaveBeenCalledOnce();
  });

  it('synchronizeProviderFile delegates to correct provider', async () => {
    const result = await sessionSynchronizerService.synchronizeProviderFile('claude', '/path/to/file.jsonl');
    expect(result).toBe('session-abc');
    expect(ALL_SYNCHRONIZERS[0].synchronizeFile).toHaveBeenCalledWith('/path/to/file.jsonl');
  });

  it('synchronizeProviderFile returns null for unknown provider', async () => {
    const result = await sessionSynchronizerService.synchronizeProviderFile('unknown', '/path/to/file.jsonl');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test -- server/modules/providers/__tests__/session-synchronizer.service.test.ts
```
Expected: FAIL with "Cannot find module '../services/session-synchronizer.service.js'"

- [ ] **Step 3: Create session synchronizer service**

Create `server/modules/providers/services/session-synchronizer.service.ts`:
```ts
import { scanStateDb } from '@/modules/database/index.js';
import { ALL_SYNCHRONIZERS } from '../registry.js';

export const sessionSynchronizerService = {
  async synchronizeSessions(): Promise<void> {
    const lastScanAt = scanStateDb.getLastScannedAt();

    for (const synchronizer of ALL_SYNCHRONIZERS) {
      try {
        await synchronizer.synchronize(lastScanAt);
      } catch (err) {
        console.error(`[session-sync] ${synchronizer.provider} synchronize failed:`, err);
      }
    }

    scanStateDb.updateLastScannedAt(new Date());
  },

  async synchronizeProviderFile(provider: string, filePath: string): Promise<string | null> {
    const synchronizer = ALL_SYNCHRONIZERS.find(s => s.provider === provider);
    if (!synchronizer) return null;

    try {
      return await synchronizer.synchronizeFile(filePath);
    } catch (err) {
      console.error(`[session-sync] ${provider} synchronizeFile failed for ${filePath}:`, err);
      return null;
    }
  },
};
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test -- server/modules/providers/__tests__/session-synchronizer.service.test.ts
```
Expected: PASS

- [ ] **Step 5: Create providers/index.ts**

Create `server/modules/providers/index.ts`:
```ts
export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { initializeSessionsWatcher, closeSessionsWatcher } from './services/sessions-watcher.service.js';
export { ALL_SYNCHRONIZERS } from './registry.js';
```

Note: `sessions-watcher.service.ts` will be created in Task 6. The index.ts can be created now (it will fail type-check until watcher is created, but that's OK).

- [ ] **Step 6: Commit**

```bash
git add server/modules/providers/services/session-synchronizer.service.ts server/modules/providers/__tests__/session-synchronizer.service.test.ts server/modules/providers/index.ts
git commit -m "feat(providers): implement session synchronizer orchestrator service"
```

---

## Task 6: Sessions Watcher Service

**Files:**
- Create: `server/modules/providers/services/sessions-watcher.service.ts`

This service replaces the `setupProjectsWatcher()` function body in `server/index.js`. It takes callbacks for `getProjects` and `broadcast` to avoid circular dependencies.

- [ ] **Step 1: Create sessions watcher service**

Create `server/modules/providers/services/sessions-watcher.service.ts`:
```ts
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
  return 'claude'; // default fallback
}

export function initializeSessionsWatcher(opts: {
  getProjects: GetProjectsFn;
  broadcast: BroadcastFn;
}): void {
  getProjectsFn = opts.getProjects;
  broadcastFn = opts.broadcast;

  // Initial sync (non-blocking)
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
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```
Expected: 0 type errors (all provider modules now complete)

- [ ] **Step 3: Run all tests**

```bash
npm test
```
Expected: 75+ tests pass

- [ ] **Step 4: Commit**

```bash
git add server/modules/providers/services/sessions-watcher.service.ts
git commit -m "feat(providers): implement sessions watcher service with DB-sync and WS broadcast"
```

---

## Task 7: Export getSessionFileMeta + DB-Backed getSessions()

**Files:**
- Modify: `server/projects.js`

The goal: `getSessions()` uses `sessionsDb.getSessionsByProjectPathPage()` as the file index instead of `fs.readdir()`. `getSessionFileMeta` is exported so it can be called from anywhere.

- [ ] **Step 1: Export getSessionFileMeta from projects.js**

In `server/projects.js`, find the `export {` block at the bottom and add `getSessionFileMeta`:
```js
export {
  getProjects,
  getSessions,
  getSessionFileMeta,    // ADD THIS LINE
  // ... rest of existing exports
};
```

Also confirm `sessionsDb` is imported at the top of `projects.js`. If not, add to the imports:
```js
import { projectsDb, sessionsDb } from './modules/database/index.js';
```
(Check existing imports first — `projectsDb` is already imported as `import { projectsDb } from './modules/database/index.js'`; update this line to also import `sessionsDb`.)

- [ ] **Step 2: Rewrite getSessions() to use DB index**

In `server/projects.js`, replace the entire `getSessions()` function body (lines ~621–690) with:
```js
async function getSessions(projectName, limit = 5, offset = 0, preFilter = null) {
  try {
    const actualProjectDir = await extractProjectDirectory(projectName);

    // DB-backed: get session rows (index only) sorted by updated_at DESC
    const pageSize = Math.max((limit + offset) * 3, 30);
    const sessionRows = sessionsDb.getSessionsByProjectPathPage(actualProjectDir, pageSize, 0)
      .filter(row => row.provider === 'claude' && row.jsonl_path);

    if (sessionRows.length === 0) {
      return { sessions: [], hasMore: false, total: 0 };
    }

    // Enrich each session with file metadata (via session_file_cache)
    const sessions = [];
    for (const row of sessionRows) {
      const meta = await getSessionFileMeta(row.jsonl_path).catch(() => null);
      if (!meta?.sessionId) continue;

      const lastActivity = meta.lastActivity ? new Date(meta.lastActivity) : meta.mtime;
      sessions.push({
        id: row.session_id,
        summary: row.custom_name
          || (meta.lastUserMessage
            ? (meta.lastUserMessage.length > 50
              ? meta.lastUserMessage.slice(0, 50) + '...'
              : meta.lastUserMessage)
            : 'New Session'),
        messageCount: meta.messageCount,
        lastActivity,
        cwd: meta.cwd || '',
        lastUserMessage: meta.lastUserMessage,
        lastAssistantMessage: meta.lastAssistantMessage,
      });
    }

    sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    const filteredSessions = preFilter ? preFilter(sessions) : sessions;
    const total = sessionsDb.countSessionsByProjectPath(actualProjectDir);
    const paginatedSessions = filteredSessions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return { sessions: paginatedSessions, hasMore, total, offset, limit };
  } catch (error) {
    console.error(`Error getting sessions for project ${projectName}:`, error);
    return { sessions: [], hasMore: false, total: 0 };
  }
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: all tests pass (getSessions changes don't affect existing tests which mock at higher level)

- [ ] **Step 4: Commit**

```bash
git add server/projects.js
git commit -m "feat(projects): getSessions() uses sessionsDb as index, keeps session_file_cache enrichment"
```

---

## Task 8: DB-Backed getProjects()

**Files:**
- Modify: `server/projects.js`

Replace the filesystem directory scan in `getProjects()` with `projectsDb.getAllProjects()`.

- [ ] **Step 1: Add pathToClaudeProjectName helper**

Near the top of `server/projects.js`, after the existing utility functions, add:
```js
/**
 * Derives the Claude project directory name from an absolute path.
 * e.g. /Users/foo/myproject → Users-foo-myproject
 */
function pathToClaudeProjectName(absolutePath) {
  return absolutePath.replace(/^\//, '').replace(/[/\\]/g, '-');
}
```

- [ ] **Step 2: Rewrite getProjects() core loop**

In `server/projects.js`, replace the `getProjects()` function. The new implementation:
- Gets projects from `projectsDb.getAllProjects()` instead of `fs.readdir(claudeDir)`
- For Claude sessions: queries `sessionsDb.getSessionsByProjectPath()`, enriches via `getSessionFileMeta()`
- For other providers: keeps calling `getCursorSessions()`, `getCodexSessions()`, `getGeminiCliSessions()` as before (DB discovery for them comes later)
- Applies all existing local feature functions unchanged

Replace the entire `getProjects` function (lines ~420–610) with:
```js
async function getProjects(progressCallback = null) {
  const projects = [];
  const codexSessionsIndexRef = { sessionsByProject: null };

  const excludedSessionIds = buildExcludedSessionIds('claude');
  const autoDocPreFilter = excludedSessionIds.size > 0
    ? (sessions) => sessions.filter(s => !excludedSessionIds.has(s.id))
    : null;

  let dbProjects = [];
  try {
    dbProjects = projectsDb.getAllProjects();
  } catch (err) {
    console.warn('[getProjects] Failed to load DB projects:', err.message);
    return [];
  }

  const totalProjects = dbProjects.length;

  for (let i = 0; i < dbProjects.length; i++) {
    const dbProject = dbProjects[i];
    const projectPath = dbProject.project_path;
    const claudeDirName = dbProject.claude_dir_name;
    const projectName = claudeDirName || pathToClaudeProjectName(projectPath);

    if (progressCallback) {
      progressCallback({
        phase: 'loading',
        current: i + 1,
        total: totalProjects,
        currentProject: path.basename(projectPath),
      });
    }

    const autoDisplayName = await generateDisplayName(projectName, projectPath);

    const project = {
      name: projectName,
      path: projectPath,
      displayName: dbProject.custom_project_name || autoDisplayName,
      fullPath: projectPath,
      isCustomName: !!dbProject.custom_project_name,
      sessions: [],
      geminiSessions: [],
      cursorSessions: [],
      codexSessions: [],
      sessionMeta: { hasMore: false, total: 0 },
    };

    // Claude sessions from DB index
    const claudeRows = sessionsDb.getSessionsByProjectPath(projectPath)
      .filter(row => row.provider === 'claude' && row.jsonl_path);
    const claudeSessions = [];
    for (const row of claudeRows) {
      const meta = await getSessionFileMeta(row.jsonl_path).catch(() => null);
      if (!meta?.sessionId) continue;
      const lastActivity = meta.lastActivity ? new Date(meta.lastActivity) : meta.mtime;
      claudeSessions.push({
        id: row.session_id,
        summary: row.custom_name
          || (meta.lastUserMessage
            ? (meta.lastUserMessage.length > 50
              ? meta.lastUserMessage.slice(0, 50) + '...'
              : meta.lastUserMessage)
            : 'New Session'),
        messageCount: meta.messageCount,
        lastActivity,
        cwd: meta.cwd || '',
        lastUserMessage: meta.lastUserMessage,
        lastAssistantMessage: meta.lastAssistantMessage,
      });
    }
    claudeSessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    // Apply local feature flags (unchanged logic)
    const filteredClaude = autoDocPreFilter ? autoDocPreFilter(claudeSessions) : claudeSessions;
    applyCustomSessionNames(filteredClaude, 'claude');
    applyHiddenFromRecents(filteredClaude, 'claude');
    applyAutoDocFlag(filteredClaude, 'claude');
    applyLastAutoDocAt(filteredClaude, 'claude');
    filterHiddenAutoDocSessions(filteredClaude);
    applyReadState(filteredClaude, 'claude');
    project.sessions = filteredClaude.slice(0, 15);
    project.sessionMeta = {
      hasMore: filteredClaude.length > 15,
      total: sessionsDb.countSessionsByProjectPath(projectPath),
    };

    // Non-Claude providers: keep existing functions for now (DB-backed via synchronizer)
    const [cursorResult, codexResult, geminiResult, taskMasterResult, gitBranchResult] =
      await Promise.allSettled([
        getCursorSessions(projectPath),
        getCodexSessions(projectPath, { indexRef: codexSessionsIndexRef }),
        (async () => {
          const uiSessions = sessionManager.getProjectSessions(projectPath) || [];
          const cliSessions = await getGeminiCliSessions(projectPath);
          const uiIds = new Set(uiSessions.map(s => s.id));
          return [...uiSessions, ...cliSessions.filter(s => !uiIds.has(s.id))];
        })(),
        detectTaskMasterFolder(projectPath),
        getProjectGitBranch(projectPath),
      ]);

    project.cursorSessions = cursorResult.status === 'fulfilled' ? cursorResult.value : [];
    applyCustomSessionNames(project.cursorSessions, 'cursor');
    applyHiddenFromRecents(project.cursorSessions, 'cursor');
    applyReadState(project.cursorSessions, 'cursor');

    project.codexSessions = codexResult.status === 'fulfilled' ? codexResult.value : [];
    applyCustomSessionNames(project.codexSessions, 'codex');
    applyHiddenFromRecents(project.codexSessions, 'codex');
    applyReadState(project.codexSessions, 'codex');

    project.geminiSessions = geminiResult.status === 'fulfilled' ? geminiResult.value : [];
    applyCustomSessionNames(project.geminiSessions, 'gemini');
    applyHiddenFromRecents(project.geminiSessions, 'gemini');
    applyReadState(project.geminiSessions, 'gemini');

    if (taskMasterResult.status === 'fulfilled' && taskMasterResult.value) {
      project.taskmaster = taskMasterResult.value;
    }
    if (gitBranchResult.status === 'fulfilled') {
      project.currentBranch = gitBranchResult.value;
    }

    projects.push(project);
  }

  return projects;
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add server/projects.js
git commit -m "feat(projects): getProjects() uses projectsDb/sessionsDb instead of filesystem scan"
```

---

## Task 9: Wire index.js — Replace Backfill + Watcher

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Import new watcher + remove backfill import**

In `server/index.js`, find and remove:
```js
import { backfillSessionsFromFileSystem } from './modules/database/backfill.js';
```

Add the new import (after existing module imports):
```js
import { initializeSessionsWatcher, closeSessionsWatcher } from './modules/providers/index.js';
```

Also import `getProjects` if not already imported:
```js
import { getProjects } from './projects.js';
```

- [ ] **Step 2: Remove backfill call in startup**

In `server/index.js`, find the startup code that calls `backfillSessionsFromFileSystem()` (likely in an async startup function or near `initializeDatabase()`). Remove that call entirely.

Search for: `backfillSessionsFromFileSystem` and delete the line calling it.

- [ ] **Step 3: Replace setupProjectsWatcher() call with initializeSessionsWatcher()**

In `server/index.js`, find the `setupProjectsWatcher()` call (around line 2773 in startup). Replace it:

Before:
```js
await setupProjectsWatcher();
```

After:
```js
initializeSessionsWatcher({
  getProjects: () => getProjects(),
  broadcast: (message) => {
    connectedClients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify(message));
      }
    });
  },
});
```

- [ ] **Step 4: Optionally add close on shutdown**

In `server/index.js`, find the graceful shutdown handler (if exists) and add:
```js
await closeSessionsWatcher();
```

- [ ] **Step 5: Run typecheck + tests**

```bash
npm run typecheck && npm test
```
Expected: 0 errors, 75+ tests pass

- [ ] **Step 6: Commit**

```bash
git add server/index.js
git commit -m "feat(server): replace filesystem watcher + backfill with initializeSessionsWatcher()"
```

---

## Task 10: Cleanup + Full Verification

**Files:**
- Delete: `server/modules/database/backfill.ts`
- Modify: `server/modules/database/index.ts` (remove backfill export if present)

- [ ] **Step 1: Delete backfill.ts**

```bash
rm server/modules/database/backfill.ts
```

- [ ] **Step 2: Remove backfill export from database/index.ts**

In `server/modules/database/index.ts`, find and remove any line that exports from `backfill`:
```ts
// Remove this line if it exists:
export { backfillSessionsFromFileSystem } from './backfill.js';
```

- [ ] **Step 3: Run full typecheck**

```bash
npm run typecheck
```
Expected: 0 errors

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: all tests pass (75+)

- [ ] **Step 5: Manual smoke test**

```bash
npm run server:dev
```

In another terminal:
```bash
# Check projects load from DB
curl -s http://localhost:3001/api/projects | python3 -m json.tool | head -50

# Check sessions load from DB
PROJECT_NAME=$(curl -s http://localhost:3001/api/projects | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['name'])" 2>/dev/null)
curl -s "http://localhost:3001/api/projects/$PROJECT_NAME/sessions" | python3 -m json.tool | head -30
```

Expected: projects and sessions returned correctly, no filesystem scan errors in server logs.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: remove backfill.ts, replaced by sessionSynchronizerService at startup

DB-first session sync complete:
- Provider synchronizers keep sessions table up-to-date
- Sessions watcher triggers DB sync on file changes
- getProjects() and getSessions() read from DB index
- session_file_cache still used for rich content metadata
- All local features (isAutoDoc, readState, hiddenFromRecents) preserved"
```
