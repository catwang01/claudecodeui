import { getConnection } from '../modules/database/connection.js';
import { initializeDatabase } from '../modules/database/init-db.js';
import { runMigrations } from '../modules/database/migrations.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = getConnection();
runMigrations();

// Show app installation path prominently
const appInstallPath = path.join(__dirname, '../..');
const dbPath = db.name;
console.log('');
console.log(`[INFO] App Installation: ${appInstallPath}`);
console.log(`[INFO] Database: ${path.relative(appInstallPath, dbPath)}`);
if (process.env.DATABASE_PATH) {
  console.log(`       (Using custom DATABASE_PATH from environment)`);
}
console.log('');

export { initializeDatabase };

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

  // Record fork parent relationship for sidebar fork-tree rendering
  markForkParent: (forkSessionId, parentSessionId, provider = 'claude') => {
    db.prepare(`
      INSERT INTO session_fork_parents (fork_session_id, parent_session_id, provider, created_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(fork_session_id, provider) DO UPDATE SET
        parent_session_id = excluded.parent_session_id
    `).run(forkSessionId, parentSessionId, provider);
  },

  // Batch lookup — returns Map<forkSessionId, parentSessionId>
  getForkParentMap: (sessionIds, provider = 'claude') => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT fork_session_id, parent_session_id
       FROM session_fork_parents
       WHERE fork_session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.fork_session_id, r.parent_session_id]));
  },

  // Remove fork relationships when a session is deleted
  removeForkLinks: (sessionId, provider = 'claude') => {
    db.prepare(
      `DELETE FROM session_fork_parents
       WHERE provider = ? AND (fork_session_id = ? OR parent_session_id = ?)`
    ).run(provider, sessionId, sessionId);
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
      ON CONFLICT(session_id, provider) DO UPDATE SET read_at = MAX(session_read_state.read_at, excluded.read_at)
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

// Apply fork parent relationship on sessions for sidebar tree rendering.
function applyForkParent(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const parentMap = sessionDb.getForkParentMap(ids, provider);
    if (!parentMap.size) return;
    for (const session of sessions) {
      const parentId = parentMap.get(session.id);
      if (parentId) session.forkParentId = parentId;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply fork parent for ${provider}:`, error.message);
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
        if (!session.lastActivity) {
          session.isRead = true;
        } else {
          const readTime = new Date(readAt);
          const lastActivity = session.lastActivity instanceof Date
            ? session.lastActivity
            : new Date(session.lastActivity);
          session.isRead = readTime >= lastActivity;
        }
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

function normalizeSessionCachePath(filePath) {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// Session file metadata cache — incremental .jsonl scan results keyed by file path
const sessionFileCache = {
  get: (filePath) => {
    const normalizedPath = normalizeSessionCachePath(filePath);
    if (process.platform !== 'win32') {
      return db.prepare('SELECT * FROM session_file_cache WHERE file_path = ?').get(normalizedPath);
    }

    return db.prepare(`
      SELECT *
      FROM session_file_cache
      WHERE file_path = ? COLLATE NOCASE
      ORDER BY updated_at DESC, file_size DESC
      LIMIT 1
    `).get(normalizedPath);
  },

  // Batch fetch: given an array of file paths, return a Map<filePath, row>.
  // Uses a single SQL query with IN clause — O(1) round trips regardless of N.
  getBatch: (filePaths) => {
    if (!filePaths || filePaths.length === 0) return new Map();
    const normalizedPaths = [...new Set(filePaths.map(normalizeSessionCachePath))];
    const placeholders = normalizedPaths.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT *
       FROM session_file_cache
       WHERE file_path ${process.platform === 'win32' ? 'COLLATE NOCASE' : ''} IN (${placeholders})
       ORDER BY updated_at DESC, file_size DESC`
    ).all(...normalizedPaths);
    const rowsByPath = new Map();
    for (const row of rows) {
      const normalizedRowPath = normalizeSessionCachePath(row.file_path);
      if (!rowsByPath.has(normalizedRowPath)) rowsByPath.set(normalizedRowPath, row);
    }
    const map = new Map();
    for (const filePath of filePaths) {
      const row = rowsByPath.get(normalizeSessionCachePath(filePath));
      if (row) map.set(filePath, row);
    }
    return map;
  },

  getBatchBySessionIds: (sessionIds) => {
    if (!sessionIds || sessionIds.length === 0) return new Map();
    const uniqueSessionIds = [...new Set(sessionIds.filter(Boolean))];
    if (uniqueSessionIds.length === 0) return new Map();
    const placeholders = uniqueSessionIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT *
      FROM session_file_cache
      WHERE session_id IN (${placeholders})
      ORDER BY datetime(last_activity) DESC, updated_at DESC, file_size DESC
    `).all(...uniqueSessionIds);
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.session_id)) map.set(row.session_id, row);
    }
    return map;
  },

  upsert: (data) => {
    const normalizedData = {
      ...data,
      file_path: normalizeSessionCachePath(data.file_path),
    };

    if (process.platform === 'win32') {
      db.prepare(
        'DELETE FROM session_file_cache WHERE file_path = ? COLLATE NOCASE AND file_path != ?'
      ).run(normalizedData.file_path, normalizedData.file_path);
    }

    return db.prepare(`
      INSERT INTO session_file_cache
        (file_path, file_size, session_id, cwd, message_count, last_activity, last_user_message, last_assistant_message, updated_at)
      VALUES
        (@file_path, @file_size, @session_id, @cwd, @message_count, @last_activity, @last_user_message, @last_assistant_message, CURRENT_TIMESTAMP)
      ON CONFLICT(file_path) DO UPDATE SET
        file_size            = excluded.file_size,
        session_id           = COALESCE(excluded.session_id, session_id),
        cwd                  = COALESCE(excluded.cwd, cwd),
        message_count        = excluded.message_count,
        last_activity        = excluded.last_activity,
        last_user_message    = COALESCE(excluded.last_user_message, last_user_message),
        last_assistant_message = COALESCE(excluded.last_assistant_message, last_assistant_message),
        updated_at           = CURRENT_TIMESTAMP
    `).run(normalizedData);
  },

  delete: (filePath) => {
    const normalizedPath = normalizeSessionCachePath(filePath);
    return db.prepare(
      `DELETE FROM session_file_cache WHERE file_path = ? ${process.platform === 'win32' ? 'COLLATE NOCASE' : ''}`
    ).run(normalizedPath);
  },

  // Return the most recent N rows ordered by last_activity (for auto-doc session collection).
  // Only returns rows for claude JSONL files that have been fully indexed (session_id + cwd).
  getRecentClaude: (limit) =>
    db.prepare(`
      SELECT file_path, session_id, cwd, message_count, last_activity, last_user_message
      FROM session_file_cache
      WHERE session_id IS NOT NULL
        AND cwd IS NOT NULL AND cwd != ''
        AND last_activity IS NOT NULL
        AND file_path LIKE ?
      ORDER BY last_activity DESC
      LIMIT ?
    `).all(path.join(os.homedir(), '.claude', 'projects', '%'), limit),
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
  userDb,
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionNamesDb,
  sessionDb,
  sessionFileCache,
  applyCustomSessionNames,
  applyHiddenFromRecents,
  applyAutoDocFlag,
  applyLastAutoDocAt,
  applyForkParent,
  filterHiddenAutoDocSessions,
  applyReadState,
  appConfigDb,
  userSettingsDb,
  githubTokensDb // Backward compatibility
};

// Re-export typed repositories for gradual migration
export { sessionsDb, projectsDb } from '../modules/database/index.js';
