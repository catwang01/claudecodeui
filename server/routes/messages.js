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
    const afterId = req.query.after_id || null;

    const _t0 = Date.now();
    const _timings = {};

    const adapter = getProvider(provider);
    if (!adapter) {
      const available = getAllProviders().join(', ');
      return res.status(400).json({ error: `Unknown provider: ${provider}. Available: ${available}` });
    }

    // Fast path for after_id: only read/normalize new messages since the last known ID.
    if (afterId && typeof adapter.fetchHistoryAfter === 'function') {
      const result = await adapter.fetchHistoryAfter(sessionId, afterId, { projectName, projectPath });
      return res.json(result);
    }

    // Fetch ALL messages first so JSONL merge sees the full picture, then paginate.
    const _t1 = Date.now();
    const fullResult = await adapter.fetchHistory(sessionId, {
      projectName,
      projectPath,
      limit: null,
      offset: 0,
    });
    _timings.fetchHistory = Date.now() - _t1;

    // Merge local user messages not yet persisted by the SDK.
    // Only role=user messages from local JSONL are considered — the rest are debug artifacts.
    //
    // Problem: a user message can be "orphaned" — written to local JSONL but never confirmed by
    // the server (e.g. sent then interrupted before Claude processed it, after which the user
    // continued chatting). The naive "append-at-end" approach silently drops orphans that are
    // followed by confirmed messages, or misplaces them.
    //
    // Two-stage placement:
    //   Stage 1 — anchor-based: scan forward in localUserMsgs from the orphan's position to find
    //     the first *confirmed* local message C; insert the orphan right before C's position in the
    //     server list. Works when the local JSONL also contains later confirmed messages.
    //   Stage 2 — timestamp fallback: when no confirmed successor exists in localUserMsgs (e.g.
    //     the local JSONL only contains the orphans themselves), binary-search the server list by
    //     timestamp and insert at the chronologically correct position.
    //   Last resort — append at end: no timestamp available (shouldn't happen in practice).
    const _t2 = Date.now();
    const localMsgs = await readMessages(sessionId);
    _timings.readLocalMsgs = Date.now() - _t2;
    const localUserMsgs = localMsgs.filter(m => m.id?.startsWith('local_'));
    if (localUserMsgs.length > 0) {
      const serverIds = new Set(fullResult.messages.map(m => m.id));
      const mappedLocalIds = new Set(
        fullResult.messages.filter(m => m.localMessageId).map(m => m.localMessageId)
      );

      const allUnconfirmed = localUserMsgs.filter(
        m => !serverIds.has(m.id) && !mappedLocalIds.has(m.id)
      );

      if (allUnconfirmed.length > 0) {
        // Build a lookup: id/localMessageId → index in fullResult.messages
        const serverIdxById = new Map();
        fullResult.messages.forEach((m, idx) => {
          serverIdxById.set(m.id, idx);
          if (m.localMessageId) serverIdxById.set(m.localMessageId, idx);
        });

        // insertBefore[serverIdx] = list of orphans to insert before that server message
        const insertBefore = new Map();
        const appendAtEnd = [];

        for (const um of allUnconfirmed) {
          // Stage 1: anchor-based — find first confirmed local successor
          const localIdx = localUserMsgs.indexOf(um);
          let anchorIdx = -1;
          for (let j = localIdx + 1; j < localUserMsgs.length; j++) {
            const next = localUserMsgs[j];
            const sIdx = serverIdxById.get(next.id)
                      ?? serverIdxById.get(next.localMessageId ?? '');
            if (sIdx !== undefined) {
              anchorIdx = sIdx;
              break;
            }
          }

          if (anchorIdx >= 0) {
            if (!insertBefore.has(anchorIdx)) insertBefore.set(anchorIdx, []);
            insertBefore.get(anchorIdx).push(um);
            continue;
          }

          // Stage 2: timestamp fallback — scan server list from the end for the last message
          // whose timestamp is <= this orphan's timestamp, then insert right after it.
          const ts = um.timestamp;
          if (ts) {
            let placed = false;
            for (let i = fullResult.messages.length - 1; i >= 0; i--) {
              const mts = fullResult.messages[i].timestamp;
              if (mts && mts <= ts) {
                const insertIdx = i + 1;
                if (!insertBefore.has(insertIdx)) insertBefore.set(insertIdx, []);
                insertBefore.get(insertIdx).push(um);
                placed = true;
                break;
              }
            }
            if (!placed) {
              // Orphan timestamp predates all server messages — prepend
              if (!insertBefore.has(0)) insertBefore.set(0, []);
              insertBefore.get(0).push(um);
            }
          } else {
            appendAtEnd.push(um);
          }
        }

        // Rebuild server message list with orphans spliced into position
        const merged = [];
        for (let i = 0; i < fullResult.messages.length; i++) {
          const pending = insertBefore.get(i);
          if (pending) merged.push(...pending);
          merged.push(fullResult.messages[i]);
        }
        merged.push(...appendAtEnd);
        fullResult.messages = merged;
      }
    }

    // Now apply pagination on the fully-merged message list.
    // If after_id is specified, return only messages after that ID (incremental fetch).
    const allMessages = fullResult.messages;
    if (afterId) {
      const idx = allMessages.findIndex(m => m.id === afterId);
      const newMessages = idx !== -1 ? allMessages.slice(idx + 1) : [];
      return res.json({
        messages: newMessages,
        total: allMessages.length,
        hasMore: false,
        offset: 0,
        limit: newMessages.length,
      });
    }

    // Tail-based: offset=0 returns the newest messages; higher offsets go further back.
    // This matches the frontend's fetchMore expectation (prepend older messages on scroll-up).
    const total = allMessages.length;
    const start = limit !== null ? Math.max(0, total - offset - limit) : 0;
    const end = limit !== null ? Math.max(0, total - offset) : total;
    const pageMessages = allMessages.slice(start, end);

    _timings.total = Date.now() - _t0;
    if (_timings.total > 500) {
      console.log(`[SLOW messages] ${sessionId} total=${_timings.total}ms fetchHistory=${_timings.fetchHistory}ms readLocalMsgs=${_timings.readLocalMsgs}ms msgs=${total}`);
    }

    return res.json({      messages: pageMessages,
      total,
      hasMore: start > 0,
      offset,
      limit,
    });
  } catch (error) {
    console.error('Error fetching unified messages:', error);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

export default router;
