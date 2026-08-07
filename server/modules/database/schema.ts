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
  claude_dir_name TEXT DEFAULT NULL,
  isStarred BOOLEAN DEFAULT 0,
  isArchived BOOLEAN DEFAULT 0
);`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  provider_session_id TEXT,
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
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
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

export const USER_SETTINGS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, key)
);`;

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

export const SESSION_FORK_PARENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_fork_parents (
  fork_session_id   TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT 'claude',
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(fork_session_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_session_fork_parents_fork
  ON session_fork_parents(fork_session_id, provider);
CREATE INDEX IF NOT EXISTS idx_session_fork_parents_parent
  ON session_fork_parents(parent_session_id, provider);`;

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
