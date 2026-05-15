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
