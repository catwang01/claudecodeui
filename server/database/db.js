import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

// Use DATABASE_PATH environment variable if set, otherwise use default location
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'auth.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');

// Ensure database directory exists if custom path is provided
if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  } catch (error) {
    console.error(`Failed to create database directory ${dbDir}:`, error.message);
    throw error;
  }
}

// As part of 1.19.2 we are introducing a new location for auth.db. The below handles exisitng moving legacy database from install directory to new location
const LEGACY_DB_PATH = path.join(__dirname, 'auth.db');
if (DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  try {
    fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
    console.log(`[MIGRATION] Copied database from ${LEGACY_DB_PATH} to ${DB_PATH}`);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(LEGACY_DB_PATH + suffix)) {
        fs.copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
      }
    }
  } catch (err) {
    console.warn(`[MIGRATION] Could not copy legacy database: ${err.message}`);
  }
}

// Create database connection
const db = new Database(DB_PATH);

// app_config must exist before any other module imports (auth.js reads the JWT secret at load time).
// runMigrations() also creates this table, but it runs too late for existing installations
// where auth.js is imported before initializeDatabase() is called.
db.exec(`CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Show app installation path prominently
const appInstallPath = path.join(__dirname, '../..');
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

const runMigrations = () => {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = tableInfo.map(col => col.name);

    if (!columnNames.includes('git_name')) {
      console.log('Running migration: Adding git_name column');
      db.exec('ALTER TABLE users ADD COLUMN git_name TEXT');
    }

    if (!columnNames.includes('git_email')) {
      console.log('Running migration: Adding git_email column');
      db.exec('ALTER TABLE users ADD COLUMN git_email TEXT');
    }

    if (!columnNames.includes('has_completed_onboarding')) {
      console.log('Running migration: Adding has_completed_onboarding column');
      db.exec('ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        user_id INTEGER PRIMARY KEY,
        preferences_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS vapid_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        keys_p256dh TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    // Create app_config table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create session_names table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS session_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      custom_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, provider)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(session_id, provider)');

    // Create session_summary_state table for tracking when sessions were last summarized
    db.exec(`CREATE TABLE IF NOT EXISTS session_summary_state (
      session_id          TEXT NOT NULL,
      provider            TEXT NOT NULL DEFAULT 'claude',
      last_summarized_at  DATETIME NOT NULL,
      last_message_count  INTEGER NOT NULL DEFAULT 0,
      last_message_text   TEXT,
      summary_duration_ms INTEGER,
      UNIQUE(session_id, provider)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_summary_state ON session_summary_state(session_id, provider)');

    // Create auto_doc_sessions table for tracking forked auto-doc sessions
    db.exec(`CREATE TABLE IF NOT EXISTS auto_doc_sessions (
      forked_session_id  TEXT PRIMARY KEY,
      source_session_id  TEXT NOT NULL,
      provider           TEXT NOT NULL DEFAULT 'claude',
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_auto_doc_sessions_source ON auto_doc_sessions(source_session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_auto_doc_sessions_forked ON auto_doc_sessions(forked_session_id)');

    // Migrate old auto_summary_sessions table to auto_doc_sessions
    // and old auto_summary_* config keys to auto_doc_* — wrapped in a transaction
    // so a crash mid-migration leaves the DB in a consistent state.
    const runLegacyMigration = db.transaction(() => {
      const oldTableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='auto_summary_sessions'"
      ).get();
      if (oldTableExists) {
        db.exec('INSERT OR IGNORE INTO auto_doc_sessions SELECT * FROM auto_summary_sessions');
        db.exec('DROP TABLE auto_summary_sessions');
      }

      const configKeyMap = {
        'auto_summary_interval_ms': 'auto_doc_interval_ms',
        'auto_summary_prompt': 'auto_doc_prompt',
        'auto_summary_min_message_count': 'auto_doc_min_message_count',
        'auto_summary_hide_sessions': 'auto_doc_hide_sessions',
      };
      for (const [oldKey, newKey] of Object.entries(configKeyMap)) {
        const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(oldKey);
        if (row) {
          db.prepare(
            'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
          ).run(newKey, row.value);
          db.prepare('DELETE FROM app_config WHERE key = ?').run(oldKey);
        }
      }
    });
    runLegacyMigration();

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

// Initialize database with schema
const initializeDatabase = async () => {
  try {
    const initSQL = fs.readFileSync(INIT_SQL_PATH, 'utf8');
    db.exec(initSQL);
    console.log('Database initialized successfully');
    runMigrations();
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
};

// User database operations
const userDb = {
  // Check if any users exist
  hasUsers: () => {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
      return row.count > 0;
    } catch (err) {
      throw err;
    }
  },

  // Create a new user
  createUser: (username, passwordHash) => {
    try {
      const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
      const result = stmt.run(username, passwordHash);
      return { id: result.lastInsertRowid, username };
    } catch (err) {
      throw err;
    }
  },

  // Get user by username
  getUserByUsername: (username) => {
    try {
      const row = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
      return row;
    } catch (err) {
      throw err;
    }
  },

  // Update last login time (non-fatal — logged but not thrown)
  updateLastLogin: (userId) => {
    try {
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    } catch (err) {
      console.warn('Failed to update last login:', err.message);
    }
  },

  // Get user by ID
  getUserById: (userId) => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE id = ? AND is_active = 1').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  getFirstUser: () => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE is_active = 1 LIMIT 1').get();
      return row;
    } catch (err) {
      throw err;
    }
  },

  updateGitConfig: (userId, gitName, gitEmail) => {
    try {
      const stmt = db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?');
      stmt.run(gitName, gitEmail, userId);
    } catch (err) {
      throw err;
    }
  },

  getGitConfig: (userId) => {
    try {
      const row = db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  completeOnboarding: (userId) => {
    try {
      const stmt = db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?');
      stmt.run(userId);
    } catch (err) {
      throw err;
    }
  },

  hasCompletedOnboarding: (userId) => {
    try {
      const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get(userId);
      return row?.has_completed_onboarding === 1;
    } catch (err) {
      throw err;
    }
  }
};

// API Keys database operations
const apiKeysDb = {
  // Generate a new API key
  generateApiKey: () => {
    return 'ck_' + crypto.randomBytes(32).toString('hex');
  },

  // Create a new API key
  createApiKey: (userId, keyName) => {
    try {
      const apiKey = apiKeysDb.generateApiKey();
      const stmt = db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)');
      const result = stmt.run(userId, keyName, apiKey);
      return { id: result.lastInsertRowid, keyName, apiKey };
    } catch (err) {
      throw err;
    }
  },

  // Get all API keys for a user
  getApiKeys: (userId) => {
    try {
      const rows = db.prepare('SELECT id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Validate API key and get user
  validateApiKey: (apiKey) => {
    try {
      const row = db.prepare(`
        SELECT u.id, u.username, ak.id as api_key_id
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.api_key = ? AND ak.is_active = 1 AND u.is_active = 1
      `).get(apiKey);

      if (row) {
        // Update last_used timestamp
        db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
      }

      return row;
    } catch (err) {
      throw err;
    }
  },

  // Delete an API key
  deleteApiKey: (userId, apiKeyId) => {
    try {
      const stmt = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?');
      const result = stmt.run(apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle API key active status
  toggleApiKey: (userId, apiKeyId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// User credentials database operations (for GitHub tokens, GitLab tokens, etc.)
const credentialsDb = {
  // Create a new credential
  createCredential: (userId, credentialName, credentialType, credentialValue, description = null) => {
    try {
      const stmt = db.prepare('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)');
      const result = stmt.run(userId, credentialName, credentialType, credentialValue, description);
      return { id: result.lastInsertRowid, credentialName, credentialType };
    } catch (err) {
      throw err;
    }
  },

  // Get all credentials for a user, optionally filtered by type
  getCredentials: (userId, credentialType = null) => {
    try {
      let query = 'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ?';
      const params = [userId];

      if (credentialType) {
        query += ' AND credential_type = ?';
        params.push(credentialType);
      }

      query += ' ORDER BY created_at DESC';

      const rows = db.prepare(query).all(...params);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Get active credential value for a user by type (returns most recent active)
  getActiveCredential: (userId, credentialType) => {
    try {
      const row = db.prepare('SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(userId, credentialType);
      return row?.credential_value || null;
    } catch (err) {
      throw err;
    }
  },

  // Delete a credential
  deleteCredential: (userId, credentialId) => {
    try {
      const stmt = db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?');
      const result = stmt.run(credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle credential active status
  toggleCredential: (userId, credentialId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

const DEFAULT_NOTIFICATION_PREFERENCES = {
  channels: {
    inApp: false,
    webPush: false
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true
  }
};

const normalizeNotificationPreferences = (value) => {
  const source = value && typeof value === 'object' ? value : {};

  return {
    channels: {
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true
    },
    events: {
      actionRequired: source.events?.actionRequired !== false,
      stop: source.events?.stop !== false,
      error: source.events?.error !== false
    }
  };
};

const notificationPreferencesDb = {
  getPreferences: (userId) => {
    try {
      const row = db.prepare('SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?').get(userId);
      if (!row) {
        const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
        db.prepare(
          'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run(userId, JSON.stringify(defaults));
        return defaults;
      }

      let parsed;
      try {
        parsed = JSON.parse(row.preferences_json);
      } catch {
        parsed = DEFAULT_NOTIFICATION_PREFERENCES;
      }
      return normalizeNotificationPreferences(parsed);
    } catch (err) {
      throw err;
    }
  },

  updatePreferences: (userId, preferences) => {
    try {
      const normalized = normalizeNotificationPreferences(preferences);
      db.prepare(
        `INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           preferences_json = excluded.preferences_json,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, JSON.stringify(normalized));
      return normalized;
    } catch (err) {
      throw err;
    }
  }
};

const pushSubscriptionsDb = {
  saveSubscription: (userId, endpoint, keysP256dh, keysAuth) => {
    try {
      db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           keys_p256dh = excluded.keys_p256dh,
           keys_auth = excluded.keys_auth`
      ).run(userId, endpoint, keysP256dh, keysAuth);
    } catch (err) {
      throw err;
    }
  },

  getSubscriptions: (userId) => {
    try {
      return db.prepare('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?').all(userId);
    } catch (err) {
      throw err;
    }
  },

  removeSubscription: (endpoint) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    } catch (err) {
      throw err;
    }
  },

  removeAllForUser: (userId) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    } catch (err) {
      throw err;
    }
  }
};

// Session custom names database operations
const sessionNamesDb = {
  // Set (insert or update) a custom session name
  setName: (sessionId, provider, customName) => {
    db.prepare(`
      INSERT INTO session_names (session_id, provider, custom_name)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider)
      DO UPDATE SET custom_name = excluded.custom_name, updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider, customName);
  },

  // Get a single custom session name
  getName: (sessionId, provider) => {
    const row = db.prepare(
      'SELECT custom_name FROM session_names WHERE session_id = ? AND provider = ?'
    ).get(sessionId, provider);
    return row?.custom_name || null;
  },

  // Batch lookup — returns Map<sessionId, customName>
  getNames: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, custom_name FROM session_names
       WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.custom_name]));
  },

  // Delete a custom session name
  deleteName: (sessionId, provider) => {
    return db.prepare(
      'DELETE FROM session_names WHERE session_id = ? AND provider = ?'
    ).run(sessionId, provider).changes > 0;
  },
};

// Generic session metadata DB (hidden from recents, extendable)
const sessionDb = {
  hideFromRecents: (sessionId, provider, lastActivityAt) => {
    db.prepare(`
      INSERT INTO session_hidden_from_recents (session_id, provider, last_activity_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider)
      DO UPDATE SET last_activity_at = excluded.last_activity_at, hidden_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider, lastActivityAt);
  },

  unhideFromRecents: (sessionId, provider) => {
    db.prepare(
      'DELETE FROM session_hidden_from_recents WHERE session_id = ? AND provider = ?'
    ).run(sessionId, provider);
  },

  // Summary state: upsert last_summarized_at, last_message_count, last_message_text, summary_duration_ms
  setDocState: (sessionId, provider, messageCount, lastMessageText, durationMs) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO session_summary_state (session_id, provider, last_summarized_at, last_message_count, last_message_text, summary_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, provider)
      DO UPDATE SET
        last_summarized_at  = excluded.last_summarized_at,
        last_message_count  = excluded.last_message_count,
        last_message_text   = excluded.last_message_text,
        summary_duration_ms = excluded.summary_duration_ms
    `).run(sessionId, provider, now, messageCount, lastMessageText, durationMs);
  },

  // Returns Map<sessionId, {last_summarized_at, last_message_count, last_message_text, summary_duration_ms}>
  getDocStateMap: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, last_summarized_at, last_message_count, last_message_text, summary_duration_ms
       FROM session_summary_state
       WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r]));
  },

  // Returns Map<sessionId, lastActivityAt>
  getHiddenMap: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, last_activity_at FROM session_hidden_from_recents
       WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.last_activity_at]));
  },

  // Records a forked session created by auto-doc
  markAsAutoDocSession: (forkedSessionId, sourceSessionId, provider) => {
    db.prepare(`
      INSERT OR IGNORE INTO auto_doc_sessions (forked_session_id, source_session_id, provider, created_at)
      VALUES (?, ?, ?, ?)
    `).run(forkedSessionId, sourceSessionId, provider, new Date().toISOString());
  },

  // Batch lookup — returns Set of forked session IDs that are auto-doc sessions
  getAutoDocSessionIds: (sessionIds, provider) => {
    if (!sessionIds.length) return new Set();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT forked_session_id FROM auto_doc_sessions
       WHERE forked_session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Set(rows.map(r => r.forked_session_id));
  },

  // Returns Set of all forked session IDs for a provider (for pre-fetching)
  getAllAutoDocSessionIds: (provider) => {
    const rows = db.prepare(
      'SELECT forked_session_id FROM auto_doc_sessions WHERE provider = ?'
    ).all(provider);
    return new Set(rows.map(r => r.forked_session_id));
  },

  // Batch lookup — returns Map of sourceSessionId -> most recent created_at
  getLastAutoDocTimestamps: (sourceSessionIds, provider) => {
    if (!sourceSessionIds.length) return new Map();
    const placeholders = sourceSessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT source_session_id, MAX(created_at) as last_auto_doc_at
       FROM auto_doc_sessions
       WHERE source_session_id IN (${placeholders}) AND provider = ?
       GROUP BY source_session_id`
    ).all(...sourceSessionIds, provider);
    return new Map(rows.map(r => [r.source_session_id, r.last_auto_doc_at]));
  },

  // Returns Set of all session IDs hidden from recents for a provider
  getAllHiddenSessionIds: (provider) => {
    const rows = db.prepare(
      'SELECT session_id FROM session_hidden_from_recents WHERE provider = ?'
    ).all(provider);
    return new Set(rows.map(r => r.session_id));
  },

  markSessionRead: (sessionId, provider, viewedAt) => {
    const ts = viewedAt || new Date().toISOString();
    db.prepare(`
      INSERT INTO session_read_state (session_id, provider, read_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider) DO UPDATE SET read_at = excluded.read_at
    `).run(sessionId, provider || 'claude', ts);
  },

  getReadStateMap: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, read_at FROM session_read_state WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider || 'claude');
    return new Map(rows.map(r => [r.session_id, r.read_at]));
  },
};

// Apply hidden-from-recents flags; auto-unhides sessions with new activity
function applyHiddenFromRecents(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const hiddenMap = sessionDb.getHiddenMap(ids, provider);
    if (!hiddenMap.size) return;
    for (const session of sessions) {
      const lastActivityAtHide = hiddenMap.get(session.id);
      if (!lastActivityAtHide) continue;
      const currentActivity = session.lastActivity || session.createdAt || '';
      if (currentActivity && currentActivity > lastActivityAtHide) {
        sessionDb.unhideFromRecents(session.id, provider);
      } else {
        session.hiddenFromRecents = true;
      }
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply hidden-from-recents for ${provider}:`, error.message);
  }
}

// Mark sessions that were created by auto-doc forks
function applyAutoDocFlag(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const summaryIds = sessionDb.getAutoDocSessionIds(ids, provider);
    if (!summaryIds.size) return;
    for (const session of sessions) {
      if (summaryIds.has(session.id)) {
        session.isAutoDoc = true;
      }
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply auto-doc flag for ${provider}:`, error.message);
  }
}

// Set lastAutoDocAt on source sessions that have been processed by auto-doc
function applyLastAutoDocAt(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const timestamps = sessionDb.getLastAutoDocTimestamps(ids, provider);
    if (!timestamps.size) return;
    for (const session of sessions) {
      const ts = timestamps.get(session.id);
      if (ts) session.lastAutoDocAt = ts;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply lastAutoDocAt for ${provider}:`, error.message);
  }
}

// Remove auto-doc sessions from the array when the hide setting is enabled.
// Must be called after applyAutoDocFlag.
function filterHiddenAutoDocSessions(sessions) {
  if (!sessions?.length) return;
  try {
    const hideRaw = appConfigDb.get('auto_doc_hide_sessions');
    const hide = hideRaw === null ? true : hideRaw === 'true';
    if (!hide) return;
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (sessions[i].isAutoDoc) sessions.splice(i, 1);
    }
  } catch (error) {
    console.warn('[DB] Failed to filter hidden auto-doc sessions:', error.message);
  }
}

// Apply read state to sessions based on session_read_state table
function applyReadState(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const readStateMap = sessionDb.getReadStateMap(ids, provider);
    if (!readStateMap.size) return;
    for (const session of sessions) {
      const readAt = readStateMap.get(session.id);
      if (readAt) {
        const readTime = new Date(readAt);
        const lastActivity = session.lastActivity instanceof Date
          ? session.lastActivity
          : new Date(session.lastActivity);
        session.isRead = readTime >= lastActivity;
      }
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply read state for ${provider}:`, error.message);
  }
}

// Apply custom session names from the database (overrides CLI-generated summaries)
function applyCustomSessionNames(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const customNames = sessionNamesDb.getNames(ids, provider);
    for (const session of sessions) {
      const custom = customNames.get(session.id);
      if (custom) session.summary = custom;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply custom session names for ${provider}:`, error.message);
  }
}

// User settings database operations (per-user key-value store)
db.exec(`CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, key)
)`);

const userSettingsDb = {
  get: (userId, key) => {
    try {
      const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(String(userId), key);
      return row?.value || null;
    } catch {
      return null;
    }
  },

  set: (userId, key, value) => {
    db.prepare(
      'INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
    ).run(String(userId), key, value);
  },

  getAll: (userId) => {
    try {
      const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(String(userId));
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    } catch {
      return {};
    }
  },
};

// App config database operations
const appConfigDb = {
  get: (key) => {
    try {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
      return row?.value || null;
    } catch (err) {
      return null;
    }
  },

  set: (key, value) => {
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  },

  getOrCreateJwtSecret: () => {
    let secret = appConfigDb.get('jwt_secret');
    if (!secret) {
      secret = crypto.randomBytes(64).toString('hex');
      appConfigDb.set('jwt_secret', secret);
    }
    return secret;
  }
};

// Backward compatibility - keep old names pointing to new system
const githubTokensDb = {
  createGithubToken: (userId, tokenName, githubToken, description = null) => {
    return credentialsDb.createCredential(userId, tokenName, 'github_token', githubToken, description);
  },
  getGithubTokens: (userId) => {
    return credentialsDb.getCredentials(userId, 'github_token');
  },
  getActiveGithubToken: (userId) => {
    return credentialsDb.getActiveCredential(userId, 'github_token');
  },
  deleteGithubToken: (userId, tokenId) => {
    return credentialsDb.deleteCredential(userId, tokenId);
  },
  toggleGithubToken: (userId, tokenId, isActive) => {
    return credentialsDb.toggleCredential(userId, tokenId, isActive);
  }
};

export {
  db,
  initializeDatabase,
  userDb,
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionNamesDb,
  sessionDb,
  applyCustomSessionNames,
  applyHiddenFromRecents,
  applyAutoDocFlag,
  applyLastAutoDocAt,
  filterHiddenAutoDocSessions,
  applyReadState,
  appConfigDb,
  userSettingsDb,
  githubTokensDb // Backward compatibility
};
