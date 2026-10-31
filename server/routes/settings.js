import express from 'express';
import { apiKeysDb, credentialsDb, notificationPreferencesDb, pushSubscriptionsDb, appConfigDb } from '../modules/database/index.js';
import { userSettingsDb } from '../database/db.js';
import { getPublicKey } from '../services/vapid-keys.js';
import { createNotificationEvent, notifyUserIfEnabled } from '../services/notification-orchestrator.js';
import { startTapForSession, stopTapForSession, getTapSession, listTapSessions, resolveAnthropicBaseUrl } from '../tap.js';

const router = express.Router();

// ===============================
// API Keys Management
// ===============================

// Get all API keys for the authenticated user
router.get('/api-keys', async (req, res) => {
  try {
    const apiKeys = apiKeysDb.getApiKeys(req.user.id);
    // Don't send the full API key in the list for security
    const sanitizedKeys = apiKeys.map(key => ({
      ...key,
      api_key: key.api_key.substring(0, 10) + '...'
    }));
    res.json({ apiKeys: sanitizedKeys });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create a new API key
router.post('/api-keys', async (req, res) => {
  try {
    const { keyName } = req.body;

    if (!keyName || !keyName.trim()) {
      return res.status(400).json({ error: 'Key name is required' });
    }

    const result = apiKeysDb.createApiKey(req.user.id, keyName.trim());
    res.json({
      success: true,
      apiKey: result
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Delete an API key
router.delete('/api-keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;
    const success = apiKeysDb.deleteApiKey(req.user.id, parseInt(keyId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Toggle API key active status
router.patch('/api-keys/:keyId/toggle', async (req, res) => {
  try {
    const { keyId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = apiKeysDb.toggleApiKey(req.user.id, parseInt(keyId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error toggling API key:', error);
    res.status(500).json({ error: 'Failed to toggle API key' });
  }
});

// ===============================
// Generic Credentials Management
// ===============================

// Get all credentials for the authenticated user (optionally filtered by type)
router.get('/credentials', async (req, res) => {
  try {
    const { type } = req.query;
    const credentials = credentialsDb.getCredentials(req.user.id, type || null);
    // Don't send the actual credential values for security
    res.json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Create a new credential
router.post('/credentials', async (req, res) => {
  try {
    const { credentialName, credentialType, credentialValue, description } = req.body;

    if (!credentialName || !credentialName.trim()) {
      return res.status(400).json({ error: 'Credential name is required' });
    }

    if (!credentialType || !credentialType.trim()) {
      return res.status(400).json({ error: 'Credential type is required' });
    }

    if (!credentialValue || !credentialValue.trim()) {
      return res.status(400).json({ error: 'Credential value is required' });
    }

    const result = credentialsDb.createCredential(
      req.user.id,
      credentialName.trim(),
      credentialType.trim(),
      credentialValue.trim(),
      description?.trim() || null
    );

    res.json({
      success: true,
      credential: result
    });
  } catch (error) {
    console.error('Error creating credential:', error);
    res.status(500).json({ error: 'Failed to create credential' });
  }
});

// Delete a credential
router.delete('/credentials/:credentialId', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const success = credentialsDb.deleteCredential(req.user.id, parseInt(credentialId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// Toggle credential active status
router.patch('/credentials/:credentialId/toggle', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = credentialsDb.toggleCredential(req.user.id, parseInt(credentialId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error toggling credential:', error);
    res.status(500).json({ error: 'Failed to toggle credential' });
  }
});

// ===============================
// Notification Preferences
// ===============================

router.get('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.getPreferences(req.user.id);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.put('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.updatePreferences(req.user.id, req.body || {});
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error saving notification preferences:', error);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// ===============================
// Push Subscription Management
// ===============================

router.get('/push/vapid-public-key', async (req, res) => {
  try {
    const publicKey = getPublicKey();
    res.json({ publicKey });
  } catch (error) {
    console.error('Error fetching VAPID public key:', error);
    res.status(500).json({ error: 'Failed to fetch VAPID public key' });
  }
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Missing subscription fields' });
    }
    pushSubscriptionsDb.saveSubscription(req.user.id, endpoint, keys.p256dh, keys.auth);

    // Enable webPush in preferences so the confirmation goes through the full pipeline
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (!currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs?.channels, webPush: true },
      });
    }

    res.json({ success: true });

    // Send a confirmation push through the full notification pipeline
    const event = createNotificationEvent({
      provider: 'system',
      kind: 'info',
      code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' },
      severity: 'info'
    });
    notifyUserIfEnabled({ userId: req.user.id, event });
  } catch (error) {
    console.error('Error saving push subscription:', error);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }
    pushSubscriptionsDb.removeSubscription(endpoint);

    // Disable webPush in preferences to match subscription state
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs.channels, webPush: false },
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

// ===============================
// Automations Configuration
// ===============================

// docs/scheduled-tasks.md section 11.2: the automations group now holds only the
// scheduled-task session toggle.
function readAutomationsConfig() {
  const hideScheduledTaskSessionsRaw = appConfigDb.get('scheduled_task_hide_sessions');
  const hideScheduledTaskSessions = hideScheduledTaskSessionsRaw === null ? true : hideScheduledTaskSessionsRaw === 'true';
  // §17 retention: how many runs per task the scheduler keeps. Unset/invalid
  // falls back to the same 50 the scheduler itself uses.
  const runRetentionRaw = appConfigDb.get('scheduled_task_run_retention');
  const parsedRetention = parseInt(runRetentionRaw, 10);
  const scheduledTaskRunRetention =
    Number.isFinite(parsedRetention) && parsedRetention >= 1 ? parsedRetention : 50;
  return { hideScheduledTaskSessions, scheduledTaskRunRetention };
}

// Applies a partial automations patch. Unknown or legacy keys (intervalMs, prompt,
// minMessageCount, model, enabled) are ignored on purpose, never a 400.
function applyAutomationsConfig(body = {}) {
  const { hideScheduledTaskSessions, scheduledTaskRunRetention } = body || {};

  if (hideScheduledTaskSessions != null) {
    appConfigDb.set('scheduled_task_hide_sessions', hideScheduledTaskSessions ? 'true' : 'false');
  }

  if (scheduledTaskRunRetention != null) {
    const parsed = Number(scheduledTaskRunRetention);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10000) {
      return 'scheduledTaskRunRetention must be an integer between 1 and 10000';
    }
    appConfigDb.set('scheduled_task_run_retention', String(parsed));
  }

  return null;
}

function handleGetAutomations(req, res) {
  try {
    res.json(readAutomationsConfig());
  } catch (error) {
    console.error('Error fetching automations config:', error);
    res.status(500).json({ error: 'Failed to fetch automations config' });
  }
}

function handleUpdateAutomations(req, res) {
  try {
    const error = applyAutomationsConfig(req.body);
    if (error) return res.status(400).json({ error });
    res.json({ success: true, ...readAutomationsConfig() });
  } catch (error) {
    console.error('Error saving automations config:', error);
    res.status(500).json({ error: 'Failed to save automations config' });
  }
}

// Automations group per docs/scheduled-tasks.md section 11.2.
router.get('/automations', handleGetAutomations);
router.post('/automations', handleUpdateAutomations);

// docs/scheduled-tasks.md section 11.2: the legacy AutoDoc surface is gone and must answer 404.
// Without these explicit tombstones a GET would fall through to the SPA catch-all, which answers
// 200 (built dist) or 302 (dev redirect to Vite) — never the 404 the contract promises. PUT has no
// catch-all, but keeping both methods here documents the removal in one place.
const handleRetiredAutoDoc = (_req, res) =>
  res.status(404).json({ error: 'AutoDoc has been retired', code: 'not_found' });
router.get('/auto-doc', handleRetiredAutoDoc);
router.put('/auto-doc', handleRetiredAutoDoc);

// ===============================
// Claude-tap (API traffic inspector) — per-session
// ===============================

router.get('/tap/sessions', (req, res) => {
  res.json(listTapSessions());
});

router.get('/tap/sessions/:sessionId', (req, res) => {
  const session = getTapSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'No tap session for this sessionId' });
  res.json({
    sessionId: req.params.sessionId,
    sessionTitle: session.sessionTitle,
    proxyPort: session.proxyPort,
    viewerPort: session.viewerPort,
    startedAt: session.startedAt,
  });
});

router.post('/tap/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { sessionTitle } = req.body;
  try {
    const targetUrl = await resolveAnthropicBaseUrl();
    const result = await startTapForSession(sessionId, sessionTitle || sessionId.slice(0, 8), targetUrl);
    res.json({ sessionId, ...result });
  } catch (err) {
    const message = err.code === 'ENOENT'
      ? 'claude-tap not found. Install with: pip install claude-tap (requires Python 3.11+)'
      : `Failed to start tap proxy: ${err.message}`;
    res.status(500).json({ error: message });
  }
});

router.delete('/tap/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getTapSession(sessionId);
  if (!session) return res.status(404).json({ error: 'No tap session for this sessionId' });
  stopTapForSession(sessionId);
  res.json({ success: true });
});

// ===============================
// User Preferences (per-user key-value)
// ===============================

// Allowed keys for user preferences
const USER_PREF_KEYS = new Set([
  'claude-settings',
  'cursor-tools-settings',
  'codex-settings',
  'gemini-settings',
  'copilot-settings',
  'code-editor-settings',
]);

router.get('/user-preferences/:key', (req, res) => {
  const { key } = req.params;
  if (!USER_PREF_KEYS.has(key)) {
    return res.status(400).json({ error: 'Unknown preference key' });
  }
  const raw = userSettingsDb.get(req.user.id, key);
  res.json({ value: raw ? JSON.parse(raw) : null });
});

router.put('/user-preferences/:key', (req, res) => {
  const { key } = req.params;
  if (!USER_PREF_KEYS.has(key)) {
    return res.status(400).json({ error: 'Unknown preference key' });
  }
  userSettingsDb.set(req.user.id, key, JSON.stringify(req.body));
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// PII Proxy Settings
// ---------------------------------------------------------------------------

router.get('/pii-proxy', (req, res) => {
  const value = appConfigDb.get('pii_proxy_enabled');
  res.json({ enabled: value === null || value === 'true' });
});

router.put('/pii-proxy', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  appConfigDb.set('pii_proxy_enabled', String(enabled));
  res.json({ enabled });
});

const PII_PROXY_BASE = `http://127.0.0.1:${process.env.PII_PROXY_PORT || 18090}`;

router.get('/pii-proxy/logs', async (req, res) => {
  try {
    const r = await fetch(`${PII_PROXY_BASE}/logs`);
    const data = await r.json();
    res.json(data);
  } catch {
    res.json({ entries: [] });
  }
});

router.delete('/pii-proxy/logs', async (req, res) => {
  try {
    await fetch(`${PII_PROXY_BASE}/logs`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'proxy unreachable' });
  }
});

router.get('/pii-proxy/pii-groups', async (req, res) => {
  try {
    const r = await fetch(`${PII_PROXY_BASE}/pii-groups`);
    const data = await r.json();
    res.json(data);
  } catch {
    res.json({ groups: [] });
  }
});

router.delete('/pii-proxy/pii-groups', async (req, res) => {
  try {
    await fetch(`${PII_PROXY_BASE}/pii-groups`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

export default router;
