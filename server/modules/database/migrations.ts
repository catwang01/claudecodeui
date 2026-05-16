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
  USER_SETTINGS_TABLE_SCHEMA_SQL,
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

const migrateLegacySessionNames = (db: Database): void => {
  if (!tableExists(db, 'session_names')) return;
  if (tableExists(db, 'sessions')) {
    // Copy data to sessions but keep session_names alive until all callers are migrated
    console.log('Running migration: Copying session_names into sessions (keeping session_names for backward compat)');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT session_id, COALESCE(provider,'claude'), custom_name,
             COALESCE(created_at, CURRENT_TIMESTAMP), COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        updated_at  = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
  } else {
    console.log('Running migration: Renaming session_names to sessions');
    db.exec('ALTER TABLE session_names RENAME TO sessions');
  }
};

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
  db.exec(USER_SETTINGS_TABLE_SCHEMA_SQL);
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
  addColumnIfMissing(db, 'projects', 'claude_dir_name', 'TEXT DEFAULT NULL');

  // Data migrations
  migrateLegacySessionNames(db);

  const autoMigrate = db.transaction(() => migrateLegacyAutoSummary(db));
  autoMigrate();

  console.log('Database migrations completed');
}
