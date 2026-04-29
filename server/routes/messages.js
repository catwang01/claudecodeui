/**
 * Unified messages endpoint.
 *
 * GET /api/sessions/:sessionId/messages?provider=claude&projectName=foo&limit=50&offset=0
 *
 * Replaces the four provider-specific session message endpoints with a single route
 * that delegates to the appropriate adapter via the provider registry.
 *
 * @module routes/messages
 */

import express from 'express';
import { getProvider, getAllProviders } from '../providers/registry.js';
import { readMessages } from '../utils/localMessageWriter.js';

const router = express.Router();

/**
 * GET /api/sessions/:sessionId/messages
 *
 * Auth: authenticateToken applied at mount level in index.js
 *
 * Query params:
 *   provider    - 'claude' | 'cursor' | 'codex' | 'gemini' (default: 'claude')
 *   projectName - required for claude provider
 *   projectPath - required for cursor provider (absolute path used for cwdId hash)
 *   limit       - page size (omit or null for all)
 *   offset      - pagination offset (default: 0)
 */
router.get('/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const provider = req.query.provider || 'claude';
    const projectName = req.query.projectName || '';
    const projectPath = req.query.projectPath || '';
    const limitParam = req.query.limit;
    const limit = limitParam !== undefined && limitParam !== null && limitParam !== ''
      ? parseInt(limitParam, 10)
      : null;
    const offset = parseInt(req.query.offset || '0', 10);

    const adapter = getProvider(provider);
    if (!adapter) {
      const available = getAllProviders().join(', ');
      return res.status(400).json({ error: `Unknown provider: ${provider}. Available: ${available}` });
    }

    const result = await adapter.fetchHistory(sessionId, {
      projectName,
      projectPath,
      limit,
      offset,
    });

    // Merge local user messages not yet persisted by the SDK.
    // Only role=user messages from local JSONL are considered — the rest are debug artifacts.
    //
    // Ordering assumption: local JSONL is append-only and chronological.
    // If a message at index i is confirmed by server, all messages before i are also confirmed.
    // So: scan user messages from the end, find the last confirmed one — everything after it is new.
    const localMsgs = await readMessages(sessionId);
    const localUserMsgs = localMsgs.filter(m => m.role === 'user' && m.id);
    if (localUserMsgs.length > 0) {
      const serverIds = new Set(result.messages.map(m => m.id));
      const mappedLocalIds = new Set(
        result.messages.filter(m => m.localMessageId).map(m => m.localMessageId)
      );
      // Find the last confirmed message (scanning from end)
      let cutoffIdx = -1;
      for (let i = localUserMsgs.length - 1; i >= 0; i--) {
        const m = localUserMsgs[i];
        if (serverIds.has(m.id) || mappedLocalIds.has(m.id)) {
          cutoffIdx = i;
          break;
        }
      }
      // Everything after the cutoff is unconfirmed — append it
      const extra = localUserMsgs.slice(cutoffIdx + 1);
      if (extra.length > 0) {
        result.messages = [...result.messages, ...extra];
        result.total = (result.total || 0) + extra.length;
      }
    }

    return res.json(result);
  } catch (error) {
    console.error('Error fetching unified messages:', error);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

export default router;
