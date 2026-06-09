/**
 * GitHub Copilot provider adapter.
 *
 * Copilot sessions are stored in ~/.copilot/session-state/{session-id}/events.jsonl
 * Each line is a JSON event with type (user.message, assistant.message, etc.)
 *
 * @module adapters/copilot
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createNormalizedMessage, generateMessageId } from '../types.js';
import { sessionsDb } from '../../modules/database/index.js';

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
   * Read Copilot session history from events.jsonl file.
   * Format: one JSON event per line with {type, data, timestamp, id}
   */
  async fetchHistory(sessionId, opts = {}) {
    try {
      // Get jsonl_path from database
      const session = sessionsDb.getSessionById(sessionId);
      if (!session || !session.jsonl_path) {
        console.log(`[copilot-adapter] No jsonl_path for session ${sessionId}`);
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: opts.limit };
      }

      const eventsPath = session.jsonl_path;

      // Check if file exists
      try {
        await fs.access(eventsPath);
      } catch {
        console.log(`[copilot-adapter] File not found: ${eventsPath}`);
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: opts.limit };
      }

      // Read and parse events.jsonl
      const content = await fs.readFile(eventsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      const messages = [];
      let messageCounter = 0;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const normalized = parseEvent(event, sessionId, messageCounter++);
          if (normalized) {
            messages.push(normalized);
          }
        } catch (err) {
          console.warn(`[copilot-adapter] Failed to parse event:`, err.message);
        }
      }

      // Apply pagination if requested
      const total = messages.length;
      const offset = opts.offset || 0;
      const limit = opts.limit;
      const paginatedMessages = limit !== null && limit !== undefined
        ? messages.slice(offset, offset + limit)
        : messages;
      const hasMore = limit !== null && limit !== undefined && (offset + limit) < total;

      return {
        messages: paginatedMessages,
        total,
        hasMore,
        offset,
        limit,
      };
    } catch (error) {
      console.error(`[copilot-adapter] fetchHistory failed for ${sessionId}:`, error);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: opts.limit };
    }
  },

  async fetchHistoryAfter(_sessionId, _afterId, _opts = {}) {
    return { messages: [], total: 0, hasMore: false };
  },
};

/**
 * Parse a Copilot event from events.jsonl into a NormalizedMessage.
 * @param {object} event - Event from events.jsonl
 * @param {string} sessionId
 * @param {number} counter - Message counter for generating unique IDs
 * @returns {import('../types.js').NormalizedMessage | null}
 */
function parseEvent(event, sessionId, counter) {
  if (!event || !event.type) return null;

  const ts = event.timestamp || new Date().toISOString();
  const eventId = event.id || `copilot_${counter}`;

  // User message
  if (event.type === 'user.message' && event.data?.content) {
    return createNormalizedMessage({
      id: eventId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'text',
      role: 'user',
      content: event.data.content,
    });
  }

  // Assistant message
  if (event.type === 'assistant.message' && event.data?.content) {
    return createNormalizedMessage({
      id: eventId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'text',
      role: 'assistant',
      content: event.data.content,
    });
  }

  // Tool use
  if (event.type === 'tool.use' && event.data) {
    return createNormalizedMessage({
      id: eventId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName: event.data.name || event.data.toolName || 'unknown',
      toolInput: event.data.input || event.data.toolInput || {},
      toolId: event.data.id || eventId,
    });
  }

  // Tool result
  if (event.type === 'tool.result' && event.data) {
    return createNormalizedMessage({
      id: eventId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: event.data.tool_use_id || event.data.toolId || '',
      content: typeof event.data.content === 'string'
        ? event.data.content
        : JSON.stringify(event.data.content || ''),
      isError: Boolean(event.data.is_error || event.data.isError),
    });
  }

  // Ignore other event types (session.start, assistant.turn_start, etc.)
  return null;
}
