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
  generated_summary TEXT,
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
  generated_summary TEXT,
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

export const SESSION_NAMES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_names (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  custom_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, provider)
);`;

export const SESSION_READ_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_read_state (
  session_id TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT 'claude',
  read_at    DATETIME NOT NULL,
  UNIQUE(session_id, provider)
);`;

export const SCHEDULED_TASKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  project_path TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  model TEXT,
  kind TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Script gate (docs section 7)
  command TEXT,
  command_timeout_seconds INTEGER,
  -- Preset installation link (docs section 10.2). NULL for ad-hoc tasks; the index for
  -- this column is created in migrations after addColumnIfMissing so that databases
  -- created before the feature are upgraded too.
  preset_id TEXT,
  preset_task_id TEXT,
  -- Parametrized scheduled tasks (docs section 12.4). NULL/'' => no parameters;
  -- databases created before the feature get the column through migrations.ts.
  params_json TEXT,
  -- Conflict policy (docs section 17): what to do when the task is due while its
  -- previous run is still in flight. 'skip' (default) | 'queue' | 'replace'.
  conflict_policy TEXT NOT NULL DEFAULT 'skip'
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);`;

export const SCHEDULED_TASK_RUNS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  -- status: 'running' | 'success' | 'error' | 'skipped' (docs section 7)
  status TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  scheduled_for TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  session_id TEXT,
  output TEXT,
  error TEXT,
  -- Script gate (docs section 7)
  script_exit_code INTEGER,
  script_output TEXT,
  prompt_used TEXT,
  -- Resolved parameter values of the run (docs section 12.4).
  params_json TEXT,
  -- Running count (docs section 14.1): ISO-8601 UTC of the moment the runner
  -- decided to call the agent. NULL until then, so gate-phase / skipped /
  -- errored-before-agent runs never count as running.
  agent_started_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task ON scheduled_task_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_session ON scheduled_task_runs(session_id);`;

// Presets (docs section 10.2): an installable bundle of task templates. `source` is
// 'builtin' (shipped catalog, re-seeded on every listPresets) or 'custom' (user made).
// `enabled` is the whole-preset switch; `project_path` is set for custom presets only.
export const SCHEDULED_TASK_PRESETS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_task_presets (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  version TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  project_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_presets_source ON scheduled_task_presets(source);`;

export const SCHEDULED_TASK_PRESET_TASKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_task_preset_tasks (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES scheduled_task_presets(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  prompt TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  model TEXT,
  kind TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  command TEXT,
  command_timeout_seconds INTEGER,
  -- Template parameter definitions (docs section 12.4).
  params_json TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_preset_tasks_preset
  ON scheduled_task_preset_tasks(preset_id, position);`;

