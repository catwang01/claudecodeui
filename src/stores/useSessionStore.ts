/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendWsMessage(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend is the source of truth (REST + local JSONL merged).
 *
 * Single messages array: server messages and realtime messages are merged on the backend.
 * REST calls (fetchFromServer / refreshFromServer) replace the array.
 * WebSocket calls (appendWsMessage) dedup-append to the array.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionProvider } from '../types/app';
import { authenticatedFetch } from '../utils/api';
import { logger } from '../utils/logger';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification'
  | 'file_download';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: SessionProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  images?: string[];
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  isMeta?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
  // Maps this server message back to the frontend optimistic local_ id it corresponds to
  localMessageId?: string;
  // Per-message token usage (assistant text messages only)
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  // file_download fields
  filename?: string;
  filepath?: string;
  downloadUrl?: string;
  fileSize?: number;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  /** Single merged array: server history + unconfirmed realtime messages, deduped. */
  messages: NormalizedMessage[];
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
  /** Timestamp of last user access — used for sessionStorage cache eviction. */
  lastAccessedAt: number;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  return {
    messages: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    lastAccessedAt: 0,
  };
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

// ─── sessionStorage cache ─────────────────────────────────────────────────────

const SS_PREFIX = 'session_msgs_';

interface SsCacheEntry {
  messages: NormalizedMessage[];
  total: number;
  lastAccessedAt: number;
}

function ssRead(sessionId: string): SsCacheEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(SS_PREFIX + sessionId);
    return raw ? (JSON.parse(raw) as SsCacheEntry) : null;
  } catch { return null; }
}

function ssWrite(sessionId: string, messages: NormalizedMessage[], total: number): void {
  if (typeof window === 'undefined') return;
  try {
    const entry: SsCacheEntry = { messages, total, lastAccessedAt: Date.now() };
    sessionStorage.setItem(SS_PREFIX + sessionId, JSON.stringify(entry));
  } catch { /* QuotaExceededError: ignore */ }
}

/**
 * Pure helper: determine whether a refresh actually changed anything worth re-rendering.
 * @internal exported for testing
 */
export function didMessagesChange(prev: NormalizedMessage[], next: NormalizedMessage[]): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i].id !== next[i].id) return true;
  }
  return false;
}

/**
 * Filter `incoming` messages to only those not already present in `existing`,
 * deduplicating by both `id` and `localMessageId`.
 * @internal exported for testing
 */
export function dedupeMessages(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  const ids = new Set(existing.map(m => m.id));
  const localIds = new Set(existing.filter(m => m.localMessageId).map(m => m.localMessageId!));
  return incoming.filter(m =>
    !ids.has(m.id) &&
    !localIds.has(m.id) &&
    !(m.localMessageId && ids.has(m.localMessageId)),
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      const cached = ssRead(sessionId);
      if (cached) {
        store.set(sessionId, {
          messages: cached.messages,
          status: 'idle',
          fetchedAt: cached.lastAccessedAt,
          total: cached.total,
          hasMore: false,
          offset: cached.messages.length,
          tokenUsage: null,
          lastAccessedAt: cached.lastAccessedAt,
        });
      } else {
        store.set(sessionId, createEmptySlot());
      }
    }
    return store.get(sessionId)!;
  }, []);

  const has = useCallback((sessionId: string) => storeRef.current.has(sessionId), []);

  /**
   * Fetch messages from the unified endpoint (server + local realtime merged by backend).
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    slot.status = 'loading';
    notify(sessionId);

    try {
      const params = new URLSearchParams();
      if (opts.provider) params.append('provider', opts.provider);
      if (opts.projectName) params.append('projectName', opts.projectName);
      if (opts.projectPath) params.append('projectPath', opts.projectPath);
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        params.append('offset', String(opts.offset ?? 0));
      }

      const qs = params.toString();
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const newMessages: NormalizedMessage[] = data.messages || [];

      slot.messages = newMessages;
      slot.total = data.total ?? newMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + newMessages.length;
      slot.fetchedAt = Date.now();
      slot.lastAccessedAt = Date.now();
      slot.status = 'idle';
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }
      ssWrite(sessionId, slot.messages, slot.total);

      // Guard: only re-render if this session is still the active one.
      // Stale responses for background sessions write slot data (so switching back
      // shows fresh data) but must not trigger a re-render for the current session.
      if (sessionId === activeSessionIdRef.current) {
        notify(sessionId);
      }
      return slot;
    } catch (error) {
      logger.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
      slot.status = 'error';
      if (sessionId === activeSessionIdRef.current) {
        notify(sessionId);
      }
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Load older (paginated) messages and prepend to messages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    if (!slot.hasMore) return slot;

    const params = new URLSearchParams();
    if (opts.provider) params.append('provider', opts.provider);
    if (opts.projectName) params.append('projectName', opts.projectName);
    if (opts.projectPath) params.append('projectPath', opts.projectPath);
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    params.append('offset', String(slot.offset));

    const qs = params.toString();
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // Prepend older messages (they're earlier in the conversation)
      slot.messages = [...olderMessages, ...slot.messages];
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      notify(sessionId);
      return slot;
    } catch (error) {
      logger.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Fetch only messages after the given message ID (incremental sync).
   * Appends new messages to the existing slot without replacing them.
   */
  const fetchIncremental = useCallback(async (
    sessionId: string,
    afterId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
    } = {},
  ): Promise<SessionSlot> => {
    const slot = getSlot(sessionId);
    if (slot.status === 'loading') return slot;
    slot.status = 'loading';
    notify(sessionId);

    try {
      const params = new URLSearchParams();
      if (opts.provider) params.append('provider', opts.provider);
      if (opts.projectName) params.append('projectName', opts.projectName);
      if (opts.projectPath) params.append('projectPath', opts.projectPath);
      params.append('after_id', afterId);

      const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`;
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const newMessages: NormalizedMessage[] = data.messages || [];

      if (newMessages.length > 0) {
        const extra = dedupeMessages(slot.messages, newMessages);
        if (extra.length > 0) {
          slot.messages = [...slot.messages, ...extra];
        }
      }
      slot.total = data.total ?? slot.total;
      slot.status = 'idle';
      slot.lastAccessedAt = Date.now();
      ssWrite(sessionId, slot.messages, slot.total);

      if (sessionId === activeSessionIdRef.current) {
        notify(sessionId);
      }
      return slot;
    } catch (error) {
      logger.error(`[SessionStore] fetchIncremental failed for ${sessionId}:`, error);
      slot.status = 'error';
      if (sessionId === activeSessionIdRef.current) {
        notify(sessionId);
      }
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Append a WebSocket message to the correct session slot.
   * Deduplicates by id and localMessageId before appending.
   */
  const appendWsMessage = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    if (dedupeMessages(slot.messages, [msg]).length === 0) return;
    slot.messages = [...slot.messages, msg];
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Append multiple WebSocket messages at once (batch), deduped.
   */
  const appendWsMessageBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    const extra = dedupeMessages(slot.messages, msgs);
    if (extra.length === 0) return;
    slot.messages = [...slot.messages, ...extra];
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Re-fetch messages from the backend (server + local realtime merged).
   * Replaces the current messages array if content changed.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    try {
      const params = new URLSearchParams();
      if (opts.provider) params.append('provider', opts.provider);
      if (opts.projectName) params.append('projectName', opts.projectName);
      if (opts.projectPath) params.append('projectPath', opts.projectPath);
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        params.append('offset', String(opts.offset ?? 0));
      }

      const qs = params.toString();
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const newMessages: NormalizedMessage[] = data.messages || [];

      // Always update metadata so isStale doesn't keep re-triggering.
      slot.fetchedAt = Date.now();
      slot.total = data.total ?? newMessages.length;
      slot.hasMore = Boolean(data.hasMore);

      const changed = didMessagesChange(slot.messages, newMessages);
      logger.log(
        `[refreshFromServer] session=${sessionId.slice(0, 8)} changed=${changed}`,
        `prev=${slot.messages.length} new=${newMessages.length}`,
      );
      if (changed) {
        slot.messages = newMessages;
        notify(sessionId);
      }
    } catch (error) {
      logger.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [getSlot, notify]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const slot = getSlot(sessionId);
    slot.status = status;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: SessionProvider) => {
    const slot = getSlot(sessionId);
    const streamId = `__streaming_${sessionId}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.messages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.messages = [...slot.messages];
      slot.messages[idx] = msg;
    } else {
      slot.messages = [...slot.messages, msg];
    }
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_${sessionId}`;
    const idx = slot.messages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.messages[idx];
      slot.messages = [...slot.messages];
      slot.messages[idx] = {
        ...stream,
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Clear a session slot before a new fetch begins.
   * Sets messages to [], status to 'loading', resets hasMore/total so the UI
   * shows a loading skeleton instead of stale messages from the previous session.
   */
  const clearSlot = useCallback((sessionId: string) => {
    const slot = getSlot(sessionId);
    slot.messages = [];
    slot.status = 'loading';
    slot.hasMore = false;
    slot.total = 0;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * No-op: kept for API compatibility. refreshFromServer now replaces messages entirely.
   */
  const clearRealtime = useCallback((_sessionId: string) => {
    // No-op: the backend merges server + local, so refreshFromServer replaces everything.
  }, []);

  /**
   * Get messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.messages ?? [];
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  /**
   * Get the last non-temporary message ID in a session (for incremental fetch).
   * Skips streaming placeholders and optimistic local_ messages.
   */
  const getLastMessageId = useCallback((sessionId: string): string | null => {
    const slot = storeRef.current.get(sessionId);
    if (!slot || slot.messages.length === 0) return null;
    for (let i = slot.messages.length - 1; i >= 0; i--) {
      const m = slot.messages[i];
      if (!m.id.startsWith('__streaming_') && !m.id.startsWith('local_')) {
        return m.id;
      }
    }
    return null;
  }, []);

  // Cleanup timer: every 5 minutes, evict sessionStorage entries older than 30 minutes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const CLEANUP_INTERVAL = 5 * 60 * 1000;
    const STALE_AFTER = 30 * 60 * 1000;
    const id = setInterval(() => {
      const now = Date.now();
      for (const key of Object.keys(sessionStorage)) {
        if (!key.startsWith(SS_PREFIX)) continue;
        try {
          const data = JSON.parse(sessionStorage.getItem(key)!) as SsCacheEntry;
          if (now - data.lastAccessedAt > STALE_AFTER) {
            sessionStorage.removeItem(key);
            const sid = key.slice(SS_PREFIX.length);
            if (storeRef.current.has(sid) && activeSessionIdRef.current !== sid) {
              storeRef.current.delete(sid);
            }
          }
        } catch {
          sessionStorage.removeItem(key);
        }
      }
    }, CLEANUP_INTERVAL);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    fetchIncremental,
    appendWsMessage,
    appendWsMessageBatch,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearSlot,
    clearRealtime,
    getMessages,
    getSessionSlot,
    getLastMessageId,
  }), [
    getSlot, has, fetchFromServer, fetchMore, fetchIncremental,
    appendWsMessage, appendWsMessageBatch, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearSlot, clearRealtime, getMessages, getSessionSlot, getLastMessageId,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
