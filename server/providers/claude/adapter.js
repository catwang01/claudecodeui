/**
 * Claude provider adapter.
 *
 * Normalizes Claude SDK session history into NormalizedMessage format.
 * @module adapters/claude
 */

import { getSessionMessages, clearSessionMessagesCache } from '../../projects.js';
import { createNormalizedMessage, generateMessageId } from '../types.js';
import { isInternalContent } from '../utils.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { resolvePendingLocalIds } from '../../localids.js';

const PROVIDER = 'claude';

// Cache for fully-normalized fetchHistory results, keyed by sessionId.
// Stores { mtime, size, result } — same mtime/size invalidation as getSessionMessages cache,
// but wraps the expensive normalize step so warm requests skip it entirely.
const fetchHistoryCache = new Map(); // sessionId → { mtime, size, result }

// localids file cache: sessionId → { size, map: Map<serverUUID, localId> }
// Incremental: only reads new bytes when file grows (append-only JSON array written as lines).
const _localidsCache = new Map();
export function clearFetchHistoryCache(sessionId) {
  if (sessionId) fetchHistoryCache.delete(sessionId);
  else fetchHistoryCache.clear();
}

/**
 * Normalize a raw JSONL message or realtime SDK event into NormalizedMessage(s).
 * Handles both history entries (JSONL `{ message: { role, content } }`) and
 * realtime streaming events (`content_block_delta`, `content_block_stop`, etc.).
 * @param {object} raw - A single entry from JSONL or a live SDK event
 * @param {string} sessionId
 * @returns {import('../types.js').NormalizedMessage[]}
 */
export function normalizeMessage(raw, sessionId) {
  // ── Streaming events (realtime) ──────────────────────────────────────────
  if (raw.type === 'content_block_delta' && raw.delta?.text) {
    return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
  }
  if (raw.type === 'content_block_stop') {
    return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
  }

  // ── History / full-message events ────────────────────────────────────────
  if (raw.type === 'attachment') return [];

  const messages = [];
  const ts = raw.timestamp || new Date().toISOString();
  const baseId = raw.id || raw.uuid || generateMessageId('claude');

  // User message
  if (raw.message?.role === 'user' && raw.message?.content) {
    const isMeta = Boolean(raw.isMeta);
    if (Array.isArray(raw.message.content)) {
      // Handle tool_result parts
      for (const part of raw.message.content) {
        if (part.type === 'tool_result') {
          messages.push(createNormalizedMessage({
            id: `${baseId}_tr_${part.tool_use_id}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_result',
            toolId: part.tool_use_id,
            content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
            isError: Boolean(part.is_error),
            subagentTools: raw.subagentTools,
            toolUseResult: raw.toolUseResult,
          }));
        } else if (part.type === 'text') {
          // Regular text parts from user
          const text = part.text || '';
          if (text && (isMeta || !isInternalContent(text))) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: text,
              isMeta,
            }));
          }
        }
      }

      // If no text parts were found, check if it's a pure user message
      if (messages.length === 0) {
        const textParts = raw.message.content
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .filter(Boolean)
          .join('\n');
        if (textParts && (isMeta || !isInternalContent(textParts))) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_text`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: textParts,
            isMeta,
          }));
        }
      }
    } else if (typeof raw.message.content === 'string') {
      const text = raw.message.content;
      if (text && (isMeta || !isInternalContent(text))) {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'user',
          content: text,
          isMeta,
        }));
      }
    }
    return messages;
  }

  // Thinking message
  if (raw.type === 'thinking' && raw.message?.content) {
    messages.push(createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'thinking',
      content: raw.message.content,
    }));
    return messages;
  }

  // Tool use result (codex-style in Claude)
  if (raw.type === 'tool_use' && raw.toolName) {
    messages.push(createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName: raw.toolName,
      toolInput: raw.toolInput,
      toolId: raw.toolCallId || baseId,
    }));
    return messages;
  }

  if (raw.type === 'tool_result') {
    messages.push(createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: raw.toolCallId || '',
      content: raw.output || '',
      isError: false,
    }));
    return messages;
  }

  // Assistant message
  // Skip synthetic SDK messages (e.g. "No response requested." when resuming a completed session)
  if (raw.message?.role === 'assistant' && raw.message?.model === '<synthetic>') {
    return messages;
  }
  if (raw.message?.role === 'assistant' && raw.message?.content) {
    if (Array.isArray(raw.message.content)) {
      let partIndex = 0;
      for (const part of raw.message.content) {
        if (part.type === 'text' && part.text) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_${partIndex}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: part.text,
          }));
        } else if (part.type === 'tool_use') {
          messages.push(createNormalizedMessage({
            id: `${baseId}_${partIndex}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: part.name,
            toolInput: part.input,
            toolId: part.id,
          }));
        } else if (part.type === 'thinking' && part.thinking) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_${partIndex}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'thinking',
            content: part.thinking,
          }));
        }
        partIndex++;
      }
    } else if (typeof raw.message.content === 'string') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content: raw.message.content,
      }));
    }
    if (messages.length > 0 && raw.message?.usage) {
      const usage = raw.message.usage;
      const tokenUsage = {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      };
      // Prefer text assistant message; fall back to messages[0] so token data is
      // never silently dropped for tool-only / thinking-only entries.
      const carrier = messages.find(m => m.kind === 'text' && m.role === 'assistant') ?? messages[0];
      carrier.tokenUsage = tokenUsage;
      // Marker for turn-level output-token aggregation (summed in fetchHistory post-processing)
      carrier._entryOutputTokens = tokenUsage.outputTokens;
    }
    return messages;
  }

  return messages;
}

/**
 * @type {import('../types.js').ProviderAdapter}
 */
export const claudeAdapter = {
  normalizeMessage,

  /**
   * Fetch session history from JSONL files, returning normalized messages.
   */
  async fetchHistory(sessionId, opts = {}) {
    const { projectName, limit = null, offset = 0 } = opts;
    if (!projectName) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const _fh0 = Date.now();
    const _fhT = {};

    // Check fetchHistory cache (wraps the expensive normalize step).
    // Only cache full-load (limit=null) requests via the fast-path single session file.
    let fileStat = null;
    if (limit === null) {
      try {
        const sessionFile = path.join(os.homedir(), '.claude', 'projects', projectName, `${sessionId}.jsonl`);
        fileStat = await fs.stat(sessionFile);
        const cached = fetchHistoryCache.get(sessionId);
        if (cached && cached.mtime === fileStat.mtimeMs && cached.size === fileStat.size) {
          return cached.result;
        }
      } catch { /* stat failed — skip cache */ }
    }
    _fhT.stat = Date.now() - _fh0;

    let result;
    try {
      result = await getSessionMessages(projectName, sessionId, limit, offset);
    } catch (error) {
      console.warn(`[ClaudeAdapter] Failed to load session ${sessionId}:`, error.message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
    _fhT.getSessionMessages = Date.now() - _fh0 - _fhT.stat;

    // getSessionMessages returns either an array (no limit) or { messages, total, hasMore }
    const rawMessages = Array.isArray(result) ? result : (result.messages || []);
    const total = Array.isArray(result) ? rawMessages.length : (result.total || 0);
    const hasMore = Array.isArray(result) ? false : Boolean(result.hasMore);

    // Load localid mappings for this session (written by claude-sdk.js)
    // Incremental: only reads bytes appended since last load.
    const localidMap = new Map(); // serverUUID → localId
    try {
      const localidsFile = path.join(os.homedir(), '.claudecodeui', 'localids', `${sessionId}.json`);
      const stat = await fs.stat(localidsFile);
      const currentSize = stat.size;
      const lidCached = _localidsCache.get(sessionId);
      if (lidCached && lidCached.size === currentSize) {
        // Cache hit — copy entries from cached map
        for (const [k, v] of lidCached.map) localidMap.set(k, v);
      } else {
        const isIncremental = lidCached && lidCached.size < currentSize;
        const startOffset = isIncremental ? lidCached.size : 0;
        const readSize = currentSize - startOffset;
        if (readSize > 0) {
          const buf = Buffer.allocUnsafe(readSize);
          const fh = await fs.open(localidsFile, 'r');
          try { await fh.read(buf, 0, readSize, startOffset); } finally { await fh.close(); }
          const newEntries = JSON.parse(buf.toString('utf8'));
          const newMap = isIncremental ? new Map(lidCached.map) : new Map();
          for (const entry of (Array.isArray(newEntries) ? newEntries : [])) {
            if (entry.serverUUID && entry.localId) newMap.set(entry.serverUUID, entry.localId);
          }
          _localidsCache.set(sessionId, { size: currentSize, map: newMap });
          for (const [k, v] of newMap) localidMap.set(k, v);
        }
      }
    } catch { /* no localids file — skip */ }
    _fhT.localids = Date.now() - _fh0 - _fhT.stat - _fhT.getSessionMessages;

    // Inline resolution: resolve any pending localId mappings using already-loaded
    // rawMessages, eliminating the race with the chokidar-triggered file write.
    const inlineResolved = resolvePendingLocalIds(sessionId, projectName, rawMessages);
    for (const [serverUUID, localId] of inlineResolved) {
      localidMap.set(serverUUID, localId);
    }

    // First pass: collect tool results for attachment to tool_use messages
    const toolResultMap = new Map();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result') {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              timestamp: raw.timestamp,
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    // Second pass: normalize all messages
    const normalized = [];
    for (const raw of rawMessages) {
      const entries = normalizeMessage(raw, sessionId);
      // Tag user text messages that have a localid mapping
      if (raw.uuid && localidMap.has(raw.uuid)) {
        for (const msg of entries) {
          if (msg.kind === 'text' && msg.role === 'user') {
            msg.localMessageId = localidMap.get(raw.uuid);
          }
        }
      }
      normalized.push(...entries);
    }

    // Attach tool results to their corresponding tool_use messages
    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const tr = toolResultMap.get(msg.toolId);
        msg.toolResult = {
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          isError: tr.isError,
          timestamp: tr.timestamp,
          toolUseResult: tr.toolUseResult,
        };
        msg.subagentTools = tr.subagentTools;
      }
    }

    // Aggregate output tokens per assistant turn.
    // Newer Claude CLI writes one JSONL entry per content block, each with its own
    // output_tokens. We sum across all blocks in the same turn (between user messages)
    // and store the total on the text message so the UI shows a meaningful number.
    let turnStart = -1;
    for (let i = 0; i <= normalized.length; i++) {
      const msg = i < normalized.length ? normalized[i] : null;
      // Positive: any non-user, non-tool_result message belongs to the assistant turn.
      const isAssistant = msg && msg.role !== 'user' && msg.kind !== 'tool_result';
      if (isAssistant && turnStart === -1) {
        turnStart = i;
      } else if (!isAssistant && turnStart !== -1) {
        const turn = normalized.slice(turnStart, i);
        let totalOutput = 0;
        for (const m of turn) {
          if (m._entryOutputTokens !== undefined) {
            totalOutput += m._entryOutputTokens;
            delete m._entryOutputTokens;
          }
        }
        if (totalOutput > 0) {
          // Prefer text assistant message; fall back to any message that already has tokenUsage
          // (e.g. thinking message in a tool-only turn).
          const textMsg = turn.find(m => m.kind === 'text' && m.role === 'assistant' && m.tokenUsage)
            ?? turn.find(m => m.tokenUsage);
          if (textMsg) {
            textMsg.tokenUsage = { ...textMsg.tokenUsage, outputTokens: totalOutput };
          }
        }
        turnStart = -1;
      }
    }

    const finalResult = {
      messages: normalized,
      total,
      hasMore,
      offset,
      limit,
    };

    // Store in fetchHistory cache if we have a reliable stat
    if (limit === null && fileStat) {
      fetchHistoryCache.set(sessionId, { mtime: fileStat.mtimeMs, size: fileStat.size, result: finalResult });
    }

    _fhT.rest = Date.now() - _fh0 - _fhT.stat - _fhT.getSessionMessages - _fhT.localids;
    const _fhTotal = Date.now() - _fh0;
    if (_fhTotal > 200) {
      console.log(`[SLOW fetchHistory] ${sessionId.slice(0,8)} total=${_fhTotal}ms stat=${_fhT.stat}ms getSessionMessages=${_fhT.getSessionMessages}ms localids=${_fhT.localids}ms rest=${_fhT.rest}ms rawMsgs=${rawMessages.length} normalizedMsgs=${normalized.length}`);
    }

    return finalResult;
  },

  /**
   * Incremental fetch: return only messages after `afterId`, O(new messages) not O(total).
   *
   * Fast paths (in order):
   *   1. Cache hit + file unchanged  → slice in memory, no I/O
   *   2. Cache hit + file grew       → read only new bytes, normalize only new lines
   *   3. Fallback                    → full fetchHistory
   */
  async fetchHistoryAfter(sessionId, afterId, opts = {}) {
    const { projectName } = opts;
    if (!projectName) return { messages: [], total: 0, hasMore: false };

    const sessionFile = path.join(os.homedir(), '.claude', 'projects', projectName, `${sessionId}.jsonl`);

    let stat;
    try { stat = await fs.stat(sessionFile); } catch { /* file gone */ }

    const cached = fetchHistoryCache.get(sessionId);

    // ── Fast path 1: cache hit, file unchanged ──────────────────────────────
    if (cached && stat && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
      const allMsgs = cached.result.messages;
      const idx = allMsgs.findIndex(m => m.id === afterId);
      return {
        messages: idx !== -1 ? allMsgs.slice(idx + 1) : [],
        total: allMsgs.length,
        hasMore: false,
      };
    }

    // ── Fast path 2: cache hit, file grew (JSONL is append-only) ───────────
    if (cached && stat && stat.size > cached.size) {
      try {
        const fh = await fs.open(sessionFile, 'r');
        const buf = Buffer.alloc(stat.size - cached.size);
        await fh.read(buf, 0, buf.length, cached.size);
        await fh.close();

        const newRaw = buf.toString('utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);

        // Assign stable ids (same logic as getSessionMessages)
        for (const msg of newRaw) {
          if (!msg.id) msg.id = msg.uuid || null;
        }

        // Normalize new messages only
        const newNormalized = [];
        for (const raw of newRaw) {
          const entries = normalizeMessage(raw, sessionId);
          newNormalized.push(...entries);
        }

        // Sort + merge with cached list
        const combined = [...cached.result.messages, ...newNormalized];

        // Update cache
        const updatedResult = { ...cached.result, messages: combined, total: combined.length };
        fetchHistoryCache.set(sessionId, { mtime: stat.mtimeMs, size: stat.size, result: updatedResult });

        const idx = combined.findIndex(m => m.id === afterId);
        return {
          messages: idx !== -1 ? combined.slice(idx + 1) : [],
          total: combined.length,
          hasMore: false,
        };
      } catch { /* fall through to full load */ }
    }

    // ── Fallback: full reload ────────────────────────────────────────────────
    if (cached) clearFetchHistoryCache(sessionId);
    const full = await this.fetchHistory(sessionId, opts);
    const allMsgs = full.messages;
    const idx = allMsgs.findIndex(m => m.id === afterId);
    return {
      messages: idx !== -1 ? allMsgs.slice(idx + 1) : [],
      total: allMsgs.length,
      hasMore: false,
    };
  },
};
