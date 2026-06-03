/**
 * GitHub Copilot provider adapter.
 *
 * Copilot sessions are managed by the Copilot CLI server (via copilot-sdk.js).
 * The CLI maintains its own session storage under ~/.copilot/, so this adapter
 * does not attempt to read history from disk. History accumulates in real-time
 * via WebSocket streaming events during an active session.
 *
 * @module adapters/copilot
 */

import { createNormalizedMessage, generateMessageId } from '../types.js';

const PROVIDER = 'copilot';

/**
 * Normalize a Copilot SDK event into NormalizedMessage(s).
 * @param {object} raw - Event from copilot-sdk.js stream
 * @param {string} sessionId
 * @returns {import('../types.js').NormalizedMessage[]}
 */
export function normalizeMessage(raw, sessionId) {
  if (!raw || !sessionId) return [];

  const ts = raw.timestamp || new Date().toISOString();
  const baseId = raw.id || generateMessageId(PROVIDER);

  // Streaming delta
  if (raw.type === 'content_block_delta' && raw.delta?.text) {
    return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
  }
  if (raw.type === 'content_block_stop') {
    return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
  }

  // Tool use
  if (raw.type === 'tool_use') {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'tool_use',
      toolName: raw.toolName || raw.name,
      toolInput: raw.toolInput || raw.input,
      toolId: raw.toolId || raw.id || baseId,
    })];
  }

  // Tool result
  if (raw.type === 'tool_result') {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'tool_result',
      toolId: raw.toolId || raw.tool_use_id || '',
      content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content),
      isError: Boolean(raw.isError || raw.is_error),
    })];
  }

  // User text
  if (raw.role === 'user' && raw.content) {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'text', role: 'user',
      content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content),
    })];
  }

  // Assistant text
  if (raw.role === 'assistant' && raw.content) {
    return [createNormalizedMessage({
      id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'text', role: 'assistant',
      content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content),
    })];
  }

  return [];
}

/**
 * @type {import('../types.js').ProviderAdapter}
 */
export const copilotAdapter = {
  normalizeMessage,

  /**
   * Copilot sessions are managed by the Copilot CLI server — history is not
   * stored in JSONL files that we can read. Return empty so the UI shows a
   * clean slate; messages accumulate in real-time during an active session.
   */
  async fetchHistory(_sessionId, _opts = {}) {
    return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
  },

  async fetchHistoryAfter(_sessionId, _afterId, _opts = {}) {
    return { messages: [], total: 0, hasMore: false };
  },
};
