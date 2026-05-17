# Backend TypeScript + DB Repository Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port upstream #654 (TypeScript toolchain) and #715 (DB repository layer) onto the current branch via surgical addition of files, without rewriting existing routes.

**Architecture:** Three layers: (1) TypeScript config + `tsx` dev runner, (2) `server/modules/database/` with typed repositories that replace scattered `db.js` helpers, (3) migrate existing JS routes to import from the new repos.  The old `db.js` stays alive during migration and is updated to use the shared `getConnection()` singleton so all code shares one SQLite handle.

**Tech Stack:** Node.js, better-sqlite3, TypeScript (tsx for dev, tsc+tsc-alias for build), ESLint with boundaries plugin.

---

## File Map

### Created
- `server/tsconfig.json`
- `server/utils/runtime-paths.js`
- `server/modules/database/connection.ts`
- `server/modules/database/schema.ts`
- `server/modules/database/migrations.ts`
- `server/modules/database/init-db.ts`
- `server/modules/database/index.ts`
- `server/modules/database/repositories/users.ts`
- `server/modules/database/repositories/api-keys.ts`
- `server/modules/database/repositories/sessions.db.ts`
- `server/modules/database/repositories/projects.db.ts`
- `server/modules/database/repositories/credentials.ts`
- `server/modules/database/repositories/github-tokens.ts`
- `server/modules/database/repositories/notification-preferences.ts`
- `server/modules/database/repositories/push-subscriptions.ts`
- `server/modules/database/repositories/vapid-keys.ts`
- `server/modules/database/repositories/app-config.ts`
- `server/modules/database/repositories/scan-state.db.ts`
- `server/shared/types.ts`
- `server/shared/utils.ts`

### Modified
- `package.json` — dev scripts, build scripts, new deps
- `tsconfig.json` — frontend alias fix
- `eslint.config.js` — add server/ coverage + boundaries plugin
- `server/database/db.js` — switch to `getConnection()` singleton
- `server/routes/auth.js` — import from new repositories
- `server/middleware/auth.js` — import from new repositories
- `server/routes/user.js` — import from new repositories
- `server/routes/settings.js` — import from new repositories

---

## Task 1: TypeScript Toolchain

**Files:**
- Create: `server/tsconfig.json`
- Create: `server/utils/runtime-paths.js`
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Install tsx and tsc-alias**

```bash
npm install --save-dev tsx tsc-alias
```

Expected output: added `tsx` and `tsc-alias` to `devDependencies`.

- [ ] **Step 2: Create server/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "baseUrl": "..",
    "paths": {
      "@/*": ["server/*"]
    },
    "allowJs": true,
    "checkJs": false,
    "strict": true,
    "noEmitOnError": true,
    "rootDir": "..",
    "outDir": "../dist-server",
    "sourceMap": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["./**/*.js", "./**/*.ts", "../shared/**/*.js", "../shared/**/*.ts"],
  "exclude": ["../dist", "../dist-server", "../node_modules", "../src"]
}
```

- [ ] **Step 3: Create server/utils/runtime-paths.js**

```js
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolves absolute paths relative to the server root at runtime,
// regardless of whether running from source or compiled dist-server/.
const serverRoot = path.resolve(__dirname, '..');
const appRoot = path.resolve(serverRoot, '..');

export function resolveServerPath(...segments) {
  return path.join(serverRoot, ...segments);
}

export function resolveAppRoot(...segments) {
  return path.join(appRoot, ...segments);
}
```

- [ ] **Step 4: Update package.json scripts**

Replace the following in `package.json`:

```json
"server:dev": "node --watch server/index.js",
"server:prod": "node server/index.js",
"server": "npm run server:dev",
"build": "vite build",
"typecheck": "tsc --noEmit -p tsconfig.json",
"lint": "eslint src/",
"lint:fix": "eslint src/ --fix"
```

With:

```json
"server:dev": "tsx --tsconfig server/tsconfig.json server/index.js",
"server:dev-watch": "tsx watch --tsconfig server/tsconfig.json server/index.js",
"server:prod": "node dist-server/server/index.js",
"server": "npm run server:dev",
"build": "npm run build:client && npm run build:server",
"build:client": "vite build",
"prebuild:server": "node -e \"require('node:fs').rmSync('dist-server', { recursive: true, force: true })\"",
"build:server": "tsc -p server/tsconfig.json && tsc-alias -p server/tsconfig.json",
"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p server/tsconfig.json",
"lint": "eslint src/ server/",
"lint:fix": "eslint src/ server/ --fix"
```

Also add `"test": "vitest run"` if not already present.

- [ ] **Step 5: Update tsconfig.json (frontend) — add baseUrl**

In `tsconfig.json`, ensure `compilerOptions` includes:
```json
"baseUrl": ".",
"paths": {
  "@/*": ["src/*"]
}
```
(The frontend already uses `@/` for `src/`; just make sure it doesn't conflict with the backend's `@/` for `server/`.)

- [ ] **Step 6: Verify the dev server still starts**

```bash
npm run server:dev &
sleep 3
curl -s http://localhost:3001/api/health || echo "server started (no health endpoint)"
kill %1
```

Expected: server starts without TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add server/tsconfig.json server/utils/runtime-paths.js package.json package-lock.json tsconfig.json
git commit -m "feat(toolchain): add TypeScript backend toolchain (#654)"
```

---

## Task 2: shared/types.ts and shared/utils.ts stubs

**Files:**
- Create: `server/shared/types.ts`
- Create: `server/shared/utils.ts`

The DB repositories import these types; we need them before adding the repositories.

- [ ] **Step 1: Create server/shared/types.ts**

```typescript
import type { IncomingMessage } from 'node:http';

export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

export type AnyRecord = Record<string, any>;

export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
};

export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
};

export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};
```

- [ ] **Step 2: Create server/shared/utils.ts**

```typescript
import path from 'node:path';

/**
 * Normalize a project path to a canonical absolute form.
 * Expands ~ to the home directory and resolves the path.
 */
export function normalizeProjectPath(projectPath: string): string {
  if (!projectPath) return projectPath;
  if (projectPath.startsWith('~/')) {
    return path.join(process.env.HOME || process.env.USERPROFILE || '~', projectPath.slice(2));
  }
  return path.resolve(projectPath);
}
```

- [ ] **Step 3: Verify TypeScript compiles the shared files**

```bash
npx tsx --tsconfig server/tsconfig.json -e "import('./server/shared/types.js').then(() => console.log('ok'))"
```

Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add server/shared/types.ts server/shared/utils.ts
git commit -m "feat(db): add server/shared types and utils for TypeScript repositories"
```

---

## Task 3: DB Connection Singleton

**Files:**
- Create: `server/modules/database/connection.ts`
- Create: `server/modules/database/schema.ts`
- Create: `server/modules/database/index.ts`

- [ ] **Step 1: Create server/modules/database/schema.ts**

This file must include ALL tables: upstream tables AND our local custom tables.

```typescript
// ─── Upstream tables ────────────────────────────────────────────────────────

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key_name TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME,
  is_active BOOLEAN DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

export const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME,
  is_active BOOLEAN DEFAULT 1,
  git_name TEXT,
  git_email TEXT,
  has_completed_onboarding BOOLEAN DEFAULT 0
);`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  credential_name TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  credential_value TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id INTEGER PRIMARY KEY,
  preferences_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  project_path TEXT NOT NULL UNIQUE,
  custom_project_name TEXT DEFAULT NULL,
  isStarred BOOLEAN DEFAULT 0,
  isArchived BOOLEAN DEFAULT 0
);`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  custom_name TEXT,
  project_path TEXT,
  jsonl_path TEXT,
  isArchived BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id),
  FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL ON UPDATE CASCADE
);`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  provider TEXT PRIMARY KEY NOT NULL,
  last_scanned_at DATETIME NOT NULL
);`;

export const GITHUB_TOKENS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS github_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  token TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

// ─── Local-only tables (not in upstream) ────────────────────────────────────

export const SESSION_SUMMARY_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_summary_state (
  session_id          TEXT NOT NULL,
  provider            TEXT NOT NULL DEFAULT 'claude',
  last_summarized_at  DATETIME NOT NULL,
  last_message_count  INTEGER NOT NULL DEFAULT 0,
  last_message_text   TEXT,
  summary_duration_ms INTEGER,
  UNIQUE(session_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_session_summary_state
  ON session_summary_state(session_id, provider);`;

export const AUTO_DOC_SESSIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS auto_doc_sessions (
  forked_session_id  TEXT PRIMARY KEY,
  source_session_id  TEXT NOT NULL,
  provider           TEXT NOT NULL DEFAULT 'claude',
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_auto_doc_sessions_source
  ON auto_doc_sessions(source_session_id);
CREATE INDEX IF NOT EXISTS idx_auto_doc_sessions_forked
  ON auto_doc_sessions(forked_session_id);`;

export const SESSION_FILE_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_file_cache (
  file_path TEXT PRIMARY KEY,
  file_size INTEGER NOT NULL,
  session_id TEXT,
  cwd TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_activity TEXT,
  last_user_message TEXT,
  last_assistant_message TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_session_file_cache_session
  ON session_file_cache(session_id);`;

export const SESSION_HIDDEN_FROM_RECENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_hidden_from_recents (
  session_id     TEXT NOT NULL,
  provider       TEXT NOT NULL DEFAULT 'claude',
  last_activity_at DATETIME,
  hidden_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, provider)
);`;

export const SESSION_READ_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_read_state (
  session_id TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT 'claude',
  read_at    DATETIME NOT NULL,
  UNIQUE(session_id, provider)
);`;
```

- [ ] **Step 2: Create server/modules/database/connection.ts**

```typescript
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { APP_CONFIG_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveDatabasePath(): string {
  return process.env.DATABASE_PATH || resolveLegacyDatabasePath();
}

function resolveLegacyDatabasePath(): string {
  const serverDir = path.resolve(__dirname, '..', '..', '..');
  return path.join(serverDir, 'database', 'auth.db');
}

function ensureDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Created database directory:', dir);
  }
}

function migrateLegacyDatabase(dbPath: string): void {
  const legacyPath = resolveLegacyDatabasePath();
  if (dbPath === legacyPath) return;
  if (fs.existsSync(dbPath)) return;
  if (!fs.existsSync(legacyPath)) return;

  try {
    fs.copyFileSync(legacyPath, dbPath);
    console.log(`[MIGRATION] Copied database from ${legacyPath} to ${dbPath}`);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(legacyPath + suffix)) {
        fs.copyFileSync(legacyPath + suffix, dbPath + suffix);
      }
    }
  } catch (err: any) {
    console.warn(`[MIGRATION] Could not copy legacy database: ${err.message}`);
  }
}

let globalConnection: InstanceType<typeof Database> | null = null;

export function getConnection(): InstanceType<typeof Database> {
  if (globalConnection) return globalConnection;

  const dbPath = resolveDatabasePath();
  ensureDatabaseDirectory(dbPath);
  migrateLegacyDatabase(dbPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Bootstrap app_config so auth middleware can read the JWT secret
  // before the full schema migration runs.
  db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);

  globalConnection = db;
  return db;
}

export function closeConnection(): void {
  if (globalConnection) {
    globalConnection.close();
    globalConnection = null;
  }
}
```

- [ ] **Step 3: Create server/modules/database/index.ts**

```typescript
export { getConnection, closeConnection } from '@/modules/database/connection.js';
export * from '@/modules/database/repositories/users.js';
export * from '@/modules/database/repositories/api-keys.js';
export * from '@/modules/database/repositories/sessions.db.js';
export * from '@/modules/database/repositories/projects.db.js';
export * from '@/modules/database/repositories/credentials.js';
export * from '@/modules/database/repositories/github-tokens.js';
export * from '@/modules/database/repositories/notification-preferences.js';
export * from '@/modules/database/repositories/push-subscriptions.js';
export * from '@/modules/database/repositories/vapid-keys.js';
export * from '@/modules/database/repositories/app-config.js';
export * from '@/modules/database/repositories/scan-state.db.js';
```

- [ ] **Step 4: Verify connection.ts compiles**

```bash
npx tsx --tsconfig server/tsconfig.json -e "
import { getConnection } from './server/modules/database/connection.js';
const db = getConnection();
console.log('DB opened at:', process.env.DATABASE_PATH || 'legacy path');
console.log('Tables:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name).join(', '));
"
```

Expected: lists existing tables without error.

- [ ] **Step 5: Commit**

```bash
git add server/modules/database/connection.ts server/modules/database/schema.ts server/modules/database/index.ts
git commit -m "feat(db): add DB connection singleton and schema definitions"
```

---

## Task 4: DB Migrations

**Files:**
- Create: `server/modules/database/migrations.ts`
- Create: `server/modules/database/init-db.ts`

- [ ] **Step 1: Create server/modules/database/migrations.ts**

```typescript
import type { Database } from 'better-sqlite3';
import { getConnection } from '@/modules/database/connection.js';
import {
  API_KEYS_TABLE_SCHEMA_SQL,
  AUTO_DOC_SESSIONS_SCHEMA_SQL,
  GITHUB_TOKENS_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSION_FILE_CACHE_SCHEMA_SQL,
  SESSION_HIDDEN_FROM_RECENTS_SCHEMA_SQL,
  SESSION_READ_STATE_SCHEMA_SQL,
  SESSION_SUMMARY_STATE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  USER_CREDENTIALS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  USER_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';

type TableInfoRow = { name: string; pk: number };

const tableExists = (db: Database, name: string): boolean =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));

const columnExists = (db: Database, table: string, column: string): boolean => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
  return cols.some(c => c.name === column);
};

const addColumnIfMissing = (db: Database, table: string, column: string, type: string): void => {
  if (!columnExists(db, table, column)) {
    console.log(`Running migration: Adding ${column} to ${table}`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
};

/** Migrate old session_names table → sessions table */
const migrateLegacySessionNames = (db: Database): void => {
  if (!tableExists(db, 'session_names')) return;
  if (tableExists(db, 'sessions')) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT session_id, COALESCE(provider,'claude'), custom_name,
             COALESCE(created_at, CURRENT_TIMESTAMP), COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider   = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at  = COALESCE(sessions.created_at, excluded.created_at),
        updated_at  = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
  } else {
    console.log('Running migration: Renaming session_names to sessions');
    db.exec('ALTER TABLE session_names RENAME TO sessions');
  }
};

/** Migrate old auto_summary_* tables / config keys → auto_doc_* */
const migrateLegacyAutoSummary = (db: Database): void => {
  if (tableExists(db, 'auto_summary_sessions')) {
    db.exec('INSERT OR IGNORE INTO auto_doc_sessions SELECT * FROM auto_summary_sessions');
    db.exec('DROP TABLE auto_summary_sessions');
  }
  const configKeyMap: Record<string, string> = {
    auto_summary_interval_ms: 'auto_doc_interval_ms',
    auto_summary_prompt: 'auto_doc_prompt',
    auto_summary_min_message_count: 'auto_doc_min_message_count',
    auto_summary_hide_sessions: 'auto_doc_hide_sessions',
  };
  for (const [old, next] of Object.entries(configKeyMap)) {
    const row = db.prepare('SELECT value FROM app_config WHERE key=?').get(old) as { value: string } | undefined;
    if (row) {
      db.prepare('INSERT INTO app_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(next, row.value);
      db.prepare('DELETE FROM app_config WHERE key=?').run(old);
    }
  }
};

export function runMigrations(): void {
  const db = getConnection();

  // Core tables
  db.exec(USER_TABLE_SCHEMA_SQL);
  db.exec(API_KEYS_TABLE_SCHEMA_SQL);
  db.exec(USER_CREDENTIALS_TABLE_SCHEMA_SQL);
  db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
  db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
  db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
  db.exec(GITHUB_TOKENS_TABLE_SCHEMA_SQL);
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);
  db.exec(SESSIONS_TABLE_SCHEMA_SQL);
  db.exec(LAST_SCANNED_AT_SQL);

  // Local-only tables
  db.exec(SESSION_SUMMARY_STATE_SCHEMA_SQL);
  db.exec(AUTO_DOC_SESSIONS_SCHEMA_SQL);
  db.exec(SESSION_FILE_CACHE_SCHEMA_SQL);
  db.exec(SESSION_HIDDEN_FROM_RECENTS_SCHEMA_SQL);
  db.exec(SESSION_READ_STATE_SCHEMA_SQL);

  // Indexes
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(project_path)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_file_cache_session ON session_file_cache(session_id)');

  // Column additions (idempotent)
  addColumnIfMissing(db, 'users', 'git_name', 'TEXT');
  addColumnIfMissing(db, 'users', 'git_email', 'TEXT');
  addColumnIfMissing(db, 'users', 'has_completed_onboarding', 'BOOLEAN DEFAULT 0');

  // Data migrations
  migrateLegacySessionNames(db);

  const autoMigrate = db.transaction(() => migrateLegacyAutoSummary(db));
  autoMigrate();

  console.log('Database migrations completed');
}
```

- [ ] **Step 2: Create server/modules/database/init-db.ts**

```typescript
import { getConnection } from '@/modules/database/connection.js';
import { runMigrations } from '@/modules/database/migrations.js';

export async function initializeDatabase(): Promise<void> {
  getConnection(); // ensures the connection is open and app_config bootstrapped
  runMigrations();
  console.log('Database initialized successfully');
}
```

- [ ] **Step 3: Verify migrations run against the existing DB**

```bash
npx tsx --tsconfig server/tsconfig.json -e "
import { initializeDatabase } from './server/modules/database/init-db.js';
await initializeDatabase();
console.log('Done');
"
```

Expected: `Database initialized successfully` and `Done`, no errors.

- [ ] **Step 4: Commit**

```bash
git add server/modules/database/migrations.ts server/modules/database/init-db.ts
git commit -m "feat(db): add TypeScript migration runner and init-db module"
```

---

## Task 5: Core DB Repositories

**Files:**
- Create: `server/modules/database/repositories/projects.db.ts`
- Create: `server/modules/database/repositories/sessions.db.ts`
- Create: `server/modules/database/repositories/users.ts`
- Create: `server/modules/database/repositories/api-keys.ts`

- [ ] **Step 1: Create server/modules/database/repositories/projects.db.ts**

Copy the full upstream version, but import from our local shared/types.ts:

```typescript
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) return trimmedCustomName;
  const directoryName = path.basename(projectPath);
  return directoryName || projectPath;
}

export const projectsDb = {
  createProjectPath(projectPath: string, customProjectName: string | null = null): CreateProjectPathResult {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
    const attemptedId = randomUUID();
    const row = db.prepare(`
      INSERT INTO projects (project_id, project_path, custom_project_name, isArchived)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(project_path) DO UPDATE SET isArchived = 0 WHERE projects.isArchived = 1
      RETURNING project_id, project_path, custom_project_name, isStarred, isArchived
    `).get(attemptedId, normalizedProjectPath, normalizedProjectName) as ProjectRepositoryRow | undefined;

    if (row) {
      return { outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived', project: row };
    }
    const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
    return { outcome: 'active_conflict', project: existingProject };
  },

  getProjectPath(projectPath: string): ProjectRepositoryRow | null {
    const db = getConnection();
    const normalized = normalizeProjectPath(projectPath);
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects WHERE project_path = ?'
    ).get(normalized) as ProjectRepositoryRow | null ?? null;
  },

  getProjectById(projectId: string): ProjectRepositoryRow | null {
    const db = getConnection();
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects WHERE project_id = ?'
    ).get(projectId) as ProjectRepositoryRow | null ?? null;
  },

  getProjectPathById(projectId: string): string | null {
    const row = projectsDb.getProjectById(projectId);
    return row?.project_path ?? null;
  },

  getAllProjects(): ProjectRepositoryRow[] {
    const db = getConnection();
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects WHERE isArchived = 0'
    ).all() as ProjectRepositoryRow[];
  },

  updateProjectStar(projectPath: string, isStarred: boolean): void {
    const db = getConnection();
    db.prepare('UPDATE projects SET isStarred = ? WHERE project_path = ?')
      .run(isStarred ? 1 : 0, normalizeProjectPath(projectPath));
  },

  updateProjectCustomName(projectPath: string, customName: string | null): void {
    const db = getConnection();
    db.prepare('UPDATE projects SET custom_project_name = ? WHERE project_path = ?')
      .run(customName, normalizeProjectPath(projectPath));
  },

  archiveProject(projectPath: string): void {
    const db = getConnection();
    db.prepare('UPDATE projects SET isArchived = 1 WHERE project_path = ?')
      .run(normalizeProjectPath(projectPath));
  },

  deleteProject(projectPath: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM projects WHERE project_path = ?')
      .run(normalizeProjectPath(projectPath));
  },
};
```

- [ ] **Step 2: Create server/modules/database/repositories/sessions.db.ts**

Copy the full upstream version unchanged (it imports from connection.ts and shared/utils.ts which we now have). The full content is in upstream at `server/modules/database/repositories/sessions.db.ts` — copy it exactly.

Key reference for verification: the file exports `sessionsDb` with these methods:
`createSession`, `updateSessionCustomName`, `getSessionById`, `getAllSessions`, `getArchivedSessions`, `getSessionsByProjectPath`, `getSessionsByProjectPathIncludingArchived`, `getSessionsByProjectPathPage`, `countSessionsByProjectPath`, `deleteSessionsByProjectPath`, `getSessionName`, `updateSessionIsArchived`, `deleteSessionById`.

```bash
git show upstream/main:server/modules/database/repositories/sessions.db.ts > server/modules/database/repositories/sessions.db.ts
```

- [ ] **Step 3: Create server/modules/database/repositories/users.ts**

```typescript
import bcrypt from 'bcrypt';
import { getConnection } from '@/modules/database/connection.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
};

export const usersDb = {
  createUser(username: string, passwordHash: string) {
    const db = getConnection();
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
    return { id: result.lastInsertRowid, username };
  },

  getUserByUsername(username: string): UserRow | null {
    const db = getConnection();
    return db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username) as UserRow | null ?? null;
  },

  getUserById(id: number): UserRow | null {
    const db = getConnection();
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | null ?? null;
  },

  updateLastLogin(userId: number): void {
    const db = getConnection();
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  },

  updateGitConfig(userId: number, gitName: string, gitEmail: string): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(gitName, gitEmail, userId);
  },

  setOnboardingComplete(userId: number): void {
    const db = getConnection();
    db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?').run(userId);
  },

  async verifyPassword(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  },

  async hashPassword(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, 12);
  },

  countUsers(): number {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row.count;
  },
};
```

- [ ] **Step 4: Create server/modules/database/repositories/api-keys.ts**

```typescript
import { getConnection } from '@/modules/database/connection.js';

export const apiKeysDb = {
  createApiKey(userId: number, keyName: string, apiKey: string) {
    const db = getConnection();
    const result = db.prepare(
      'INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)'
    ).run(userId, keyName, apiKey);
    return { id: result.lastInsertRowid };
  },

  getApiKeyByKey(apiKey: string) {
    const db = getConnection();
    return db.prepare(
      'SELECT id, user_id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE api_key = ? AND is_active = 1'
    ).get(apiKey);
  },

  getApiKeysByUserId(userId: number) {
    const db = getConnection();
    return db.prepare(
      'SELECT id, user_id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ?'
    ).all(userId);
  },

  updateLastUsed(apiKeyId: number): void {
    const db = getConnection();
    db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(apiKeyId);
  },

  deactivateApiKey(apiKeyId: number, userId: number): boolean {
    const db = getConnection();
    return db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?').run(apiKeyId, userId).changes > 0;
  },

  deleteApiKey(apiKeyId: number, userId: number): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(apiKeyId, userId).changes > 0;
  },
};
```

- [ ] **Step 5: Verify repositories import correctly**

```bash
npx tsx --tsconfig server/tsconfig.json -e "
import { usersDb } from './server/modules/database/repositories/users.js';
import { sessionsDb } from './server/modules/database/repositories/sessions.db.js';
import { projectsDb } from './server/modules/database/repositories/projects.db.js';
import { apiKeysDb } from './server/modules/database/repositories/api-keys.js';
console.log('All core repositories imported OK');
"
```

Expected: `All core repositories imported OK`

- [ ] **Step 6: Commit**

```bash
git add server/modules/database/repositories/
git commit -m "feat(db): add core TypeScript repositories (sessions, projects, users, api-keys)"
```

---

## Task 6: Supporting Repositories

**Files:**
- Create: `server/modules/database/repositories/credentials.ts`
- Create: `server/modules/database/repositories/github-tokens.ts`
- Create: `server/modules/database/repositories/notification-preferences.ts`
- Create: `server/modules/database/repositories/push-subscriptions.ts`
- Create: `server/modules/database/repositories/vapid-keys.ts`
- Create: `server/modules/database/repositories/app-config.ts`
- Create: `server/modules/database/repositories/scan-state.db.ts`

Copy each from upstream:

```bash
git show upstream/main:server/modules/database/repositories/credentials.ts > server/modules/database/repositories/credentials.ts
git show upstream/main:server/modules/database/repositories/github-tokens.ts > server/modules/database/repositories/github-tokens.ts
git show upstream/main:server/modules/database/repositories/notification-preferences.ts > server/modules/database/repositories/notification-preferences.ts
git show upstream/main:server/modules/database/repositories/push-subscriptions.ts > server/modules/database/repositories/push-subscriptions.ts
git show upstream/main:server/modules/database/repositories/vapid-keys.ts > server/modules/database/repositories/vapid-keys.ts
git show upstream/main:server/modules/database/repositories/app-config.ts > server/modules/database/repositories/app-config.ts
git show upstream/main:server/modules/database/repositories/scan-state.db.ts > server/modules/database/repositories/scan-state.db.ts
```

- [ ] **Step 1: Run the above copy commands**

- [ ] **Step 2: Verify they compile**

```bash
npx tsx --tsconfig server/tsconfig.json -e "
import { credentialsDb } from './server/modules/database/repositories/credentials.js';
import { githubTokensDb } from './server/modules/database/repositories/github-tokens.js';
import { notificationPreferencesDb } from './server/modules/database/repositories/notification-preferences.js';
import { appConfigDb } from './server/modules/database/repositories/app-config.js';
console.log('All supporting repositories OK');
"
```

Expected: `All supporting repositories OK`

- [ ] **Step 3: Commit**

```bash
git add server/modules/database/repositories/
git commit -m "feat(db): add supporting TypeScript repositories"
```

---

## Task 7: Update db.js to Use Connection Singleton

**Files:**
- Modify: `server/database/db.js`

Currently `db.js` opens its own `new Database(DB_PATH)` connection.  We need it to use the same singleton as the TypeScript repositories to avoid two open handles.

- [ ] **Step 1: Replace the connection code in db.js**

Find and remove these lines (around line 20-60):

```js
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'auth.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');
// ... legacy migration block ...
const db = new Database(DB_PATH);
```

Replace with:

```js
import { getConnection } from '../modules/database/connection.js';
const db = getConnection();
```

Also remove the `import Database from 'better-sqlite3';` line and the color logging helpers (they're no longer needed for db init), keeping all the actual DB function implementations.

- [ ] **Step 2: Update initializeDatabase() in db.js**

Replace the `initializeDatabase` async function (which read from init.sql and called runMigrations) with an import of the new module:

```js
import { initializeDatabase } from '../modules/database/init-db.js';
export { initializeDatabase };
```

Remove the old `const runMigrations = () => {...}` and `const initializeDatabase = async () => {...}` implementations from db.js entirely.

- [ ] **Step 3: Verify server starts**

```bash
npm run server:dev &
sleep 4
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ && echo ""
kill %1
```

Expected: HTTP 200 (or whatever the server returns for `/`).

- [ ] **Step 4: Run the test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/database/db.js
git commit -m "refactor(db): switch db.js to use shared getConnection() singleton"
```

---

## Task 8: Migrate Auth Routes to TypeScript Repositories

**Files:**
- Modify: `server/routes/auth.js`
- Modify: `server/middleware/auth.js`
- Modify: `server/routes/user.js`

- [ ] **Step 1: Update server/routes/auth.js**

Find all `userDb.` and `apiKeysDb.` calls that were imported from `../database/db.js`.

Add at the top of the import section:
```js
import { usersDb, apiKeysDb } from '../modules/database/index.js';
```

Replace `userDb.createUser(...)` → `usersDb.createUser(...)` (note: `usersDb` not `userDb`).
Replace `apiKeysDb.createApiKey(...)` → keep same name (the new repo has the same method names).
Replace `userDb.getUserByUsername(...)` → `usersDb.getUserByUsername(...)`.
Replace `userDb.updateLastLogin(...)` → `usersDb.updateLastLogin(...)`.

Remove the old import of `userDb` and `apiKeysDb` from `db.js`.

- [ ] **Step 2: Update server/middleware/auth.js**

Replace the `db.js` imports with:
```js
import { apiKeysDb, appConfigDb, usersDb } from '../modules/database/index.js';
```

Map function calls:
- `apiKeysDb.getApiKeyByKey(key)` → same
- `apiKeysDb.updateLastUsed(id)` → same
- `appConfigDb.getConfig(key)` → same
- `userDb.getUserById(id)` → `usersDb.getUserById(id)`

- [ ] **Step 3: Update server/routes/user.js**

Replace `db.js` imports of `userDb`, `notificationPreferencesDb`, `credentialsDb` with:
```js
import { usersDb, notificationPreferencesDb, credentialsDb } from '../modules/database/index.js';
```

Map:
- `userDb.*` → `usersDb.*`
- `notificationPreferencesDb.*` → same (same interface)
- `credentialsDb.*` → same

- [ ] **Step 4: Smoke-test login flow**

```bash
npm run server:dev &
sleep 4
# Test login endpoint
curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"edward","password":"password123"}' | python3 -m json.tool
kill %1
```

Expected: JSON with `token` field (or appropriate auth response).

- [ ] **Step 5: Run tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/routes/auth.js server/middleware/auth.js server/routes/user.js
git commit -m "refactor(auth): migrate auth routes to TypeScript DB repositories"
```

---

## Task 9: Migrate Session and Project Metadata

**Files:**
- Modify: `server/database/db.js` — remove session/project operations that are now in repositories
- Modify: `server/routes/settings.js`

This is the most impactful step — routing all session metadata through the typed repositories.

- [ ] **Step 1: Export sessionsDb and projectsDb from db.js (transitional)**

In `server/database/db.js`, add re-exports at the bottom so callers can switch gradually:

```js
export { sessionsDb, projectsDb } from '../modules/database/index.js';
```

This allows existing callers of `db.js` that do `import { sessionsDb } from '../database/db.js'` to still work while we migrate.

- [ ] **Step 2: Update server/routes/settings.js**

Find imports from `db.js` that reference `vapidKeysDb`, `pushSubscriptionsDb`, `appConfigDb`.

Replace with:
```js
import { vapidKeysDb, pushSubscriptionsDb, appConfigDb } from '../modules/database/index.js';
```

- [ ] **Step 3: Update server/services/vapid-keys.js**

```js
import { vapidKeysDb } from '../modules/database/index.js';
```

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 5: Verify server starts and sessions load**

```bash
npm run server:dev &
sleep 4
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"edward","password":"password123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s http://localhost:3001/api/projects \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -30
kill %1
```

Expected: JSON list of projects without error.

- [ ] **Step 6: Commit**

```bash
git add server/database/db.js server/routes/settings.js server/services/vapid-keys.js
git commit -m "refactor(db): migrate session/project metadata to TypeScript repositories"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npx vitest run` — all 64+ tests pass
- [ ] Dev server starts: `npm run server:dev`
- [ ] Login works and returns JWT token
- [ ] Project list loads (GET /api/projects)
- [ ] Sessions visible in project (sessions use DB repository)
- [ ] `npm run build` completes (frontend + backend TypeScript compile)
