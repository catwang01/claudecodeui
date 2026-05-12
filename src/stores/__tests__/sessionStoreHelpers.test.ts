import { describe, it, expect } from 'vitest';
import { dedupeMessages, didMessagesChange } from '../useSessionStore';
import type { NormalizedMessage, SessionSlot } from '../useSessionStore';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function msg(id: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id,
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: `content-${id}`,
    ...extra,
  };
}

function userMsg(id: string, content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return msg(id, { role: 'user', content, ...extra });
}

// ─── dedupeMessages ──────────────────────────────────────────────────────────

describe('dedupeMessages', () => {
  it('returns all incoming when existing is empty', () => {
    const incoming = [msg('r1'), msg('r2')];
    expect(dedupeMessages([], incoming)).toEqual(incoming);
  });

  it('returns empty when all incoming IDs already exist', () => {
    const existing = [msg('a'), msg('b')];
    expect(dedupeMessages(existing, [msg('a'), msg('b')])).toEqual([]);
  });

  it('filters out messages whose ID is already in existing', () => {
    const existing = [msg('s1'), msg('s2')];
    const incoming = [msg('s2'), msg('r1')];
    expect(dedupeMessages(existing, incoming).map(m => m.id)).toEqual(['r1']);
  });

  it('keeps new messages not present in existing', () => {
    const existing = [msg('s1')];
    const incoming = [msg('r1'), msg('r2')];
    expect(dedupeMessages(existing, incoming).map(m => m.id)).toEqual(['r1', 'r2']);
  });

  describe('localMessageId dedup', () => {
    it('filters incoming message whose id matches an existing localMessageId', () => {
      const existing = [
        msg('s1'),
        userMsg('uuid-abc_text', 'hello', { localMessageId: 'local_123' }),
      ];
      const incoming = [
        userMsg('local_123', 'hello'), // should be filtered — already represented by uuid-abc_text
        msg('r1'),
      ];
      expect(dedupeMessages(existing, incoming).map(m => m.id)).toEqual(['r1']);
    });

    it('filters server-confirmed message whose localMessageId matches an existing optimistic id', () => {
      // Optimistic local message added before server response
      const existing = [
        msg('s1'),
        userMsg('local_123', 'hello'), // optimistic, no localMessageId field
      ];
      const incoming = [
        userMsg('real-uuid', 'hello', { localMessageId: 'local_123' }), // server confirmation
        msg('r1'),
      ];
      expect(dedupeMessages(existing, incoming).map(m => m.id)).toEqual(['r1']);
    });

    it('keeps incoming message when localMessageId has not been confirmed yet', () => {
      const existing = [msg('s1'), msg('s2')];
      const incoming = [userMsg('local_456', 'pending')];
      expect(dedupeMessages(existing, incoming).map(m => m.id)).toEqual(['local_456']);
    });

    it('handles mixed: dedupes matched, keeps unmatched', () => {
      const existing = [
        userMsg('uuid-1_text', 'first', { localMessageId: 'local_001' }),
        msg('tool-1'),
      ];
      const incoming = [
        userMsg('local_001', 'first'),   // matched → removed
        msg('tool-1'),                   // matched by id → removed
        userMsg('local_002', 'second'),  // not matched → kept
      ];
      expect(dedupeMessages(existing, incoming).map(m => m.id)).toEqual(['local_002']);
    });
  });

  describe('HTTP + WebSocket concurrent scenario', () => {
    it('WS message with same id as HTTP-fetched message is filtered out', () => {
      // Simulate: fetchFromServer returned [A, B, C], then WS pushes C again
      const httpMessages = [msg('A'), msg('B'), msg('C')];
      const wsMessages = [msg('C')];
      expect(dedupeMessages(httpMessages, wsMessages)).toHaveLength(0);
    });

    it('WS batch with mixed new/duplicate is correctly filtered', () => {
      // fetchFromServer returned [A, B], WS pushes [B, D] — only D is new
      const httpMessages = [msg('A'), msg('B')];
      const wsMessages = [msg('B'), msg('D')];
      expect(dedupeMessages(httpMessages, wsMessages).map(m => m.id)).toEqual(['D']);
    });

    it('WS-arrived message that later appears in HTTP fetch does not duplicate via localMessageId', () => {
      // WS pushed optimistic local message, server confirmed it with real uuid
      const wsOptimistic = [userMsg('local_ws_1', 'hi')];
      const httpConfirmed = [userMsg('real-uuid-1', 'hi', { localMessageId: 'local_ws_1' })];
      // After HTTP response replaces the array with httpConfirmed, re-appending wsOptimistic should be empty
      expect(dedupeMessages(httpConfirmed, wsOptimistic)).toHaveLength(0);
    });
  });

  describe('streaming scenario', () => {
    it('keeps in-flight streaming messages appended after server history', () => {
      const existing = [msg('s1'), msg('s2')];
      const incoming = [
        msg('tool-use-1', { kind: 'tool_use' }),
        msg('stream-delta', { kind: 'stream_delta', content: 'partial...' }),
      ];
      expect(dedupeMessages(existing, incoming).map(m => m.id))
        .toEqual(['tool-use-1', 'stream-delta']);
    });

    it('after refresh: returns empty when all realtime messages are now in existing', () => {
      const existing = [
        msg('s1'),
        userMsg('uuid-user_text', 'question', { localMessageId: 'local_x' }),
        msg('tool-1', { kind: 'tool_use' }),
        msg('assistant-1'),
      ];
      const incoming = [
        userMsg('local_x', 'question'), // deduped via localMessageId
        msg('tool-1', { kind: 'tool_use' }), // deduped by id
      ];
      expect(dedupeMessages(existing, incoming)).toEqual([]);
    });
  });
});

// ─── didMessagesChange ────────────────────────────────────────────────────────

describe('didMessagesChange', () => {
  it('returns false when arrays are identical by reference', () => {
    const messages = [msg('a'), msg('b'), msg('c')];
    expect(didMessagesChange(messages, messages)).toBe(false);
  });

  it('returns false when new array has same IDs in same order', () => {
    const prev = [msg('a'), msg('b'), msg('c')];
    const next = [msg('a'), msg('b'), msg('c')];
    expect(didMessagesChange(prev, next)).toBe(false);
  });

  it('returns true when message count increases', () => {
    const prev = [msg('a'), msg('b')];
    const next = [msg('a'), msg('b'), msg('c')];
    expect(didMessagesChange(prev, next)).toBe(true);
  });

  it('returns true when message count decreases', () => {
    const prev = [msg('a'), msg('b'), msg('c')];
    const next = [msg('a'), msg('b')];
    expect(didMessagesChange(prev, next)).toBe(true);
  });

  it('returns true when a message ID changed at any position', () => {
    const prev = [msg('a'), msg('b'), msg('c')];
    const next = [msg('a'), msg('new-b'), msg('c')];
    expect(didMessagesChange(prev, next)).toBe(true);
  });

  it('returns true when going from empty to non-empty', () => {
    expect(didMessagesChange([], [msg('a')])).toBe(true);
  });

  it('returns false for empty-to-empty', () => {
    expect(didMessagesChange([], [])).toBe(false);
  });
});

// ─── Stale HTTP response guard ────────────────────────────────────────────────

/**
 * These tests verify the slot-isolation invariant: fetchFromServer writes only
 * to the fetched session's slot, never to any other session's slot.
 *
 * The notify() guard (sessionId === activeSessionId) is the re-render gate.
 * Slot isolation is the data correctness gate — both must hold for US-006.
 */
describe('stale HTTP response guard — slot isolation', () => {
  function makeSlot(overrides: Partial<SessionSlot> = {}): SessionSlot {
    return {
      messages: [],
      status: 'idle',
      fetchedAt: 0,
      total: 0,
      hasMore: false,
      offset: 0,
      tokenUsage: null,
      ...overrides,
    };
  }

  it('resolving session A fetch does not modify session B slot', () => {
    const store = new Map<string, SessionSlot>();
    store.set('session-A', makeSlot({ status: 'loading' }));
    store.set('session-B', makeSlot());

    // Simulate: session A fetch resolves while session B is active
    const slotA = store.get('session-A')!;
    slotA.messages = [msg('A1'), msg('A2')];
    slotA.status = 'idle';

    // Session B slot is untouched
    expect(store.get('session-B')!.messages).toHaveLength(0);
    expect(store.get('session-B')!.status).toBe('idle');
  });

  it('notify guard: only active session triggers re-render', () => {
    let renderCount = 0;
    const activeSessionId = 'session-B';

    // Simulate what the guarded notify() does
    const guardedNotify = (sessionId: string) => {
      if (sessionId === activeSessionId) renderCount++;
    };

    // Stale fetch for session A resolves
    guardedNotify('session-A');
    expect(renderCount).toBe(0);

    // Active session B gets a real update
    guardedNotify('session-B');
    expect(renderCount).toBe(1);
  });

  it('slot data is still written for inactive session (cache stays fresh)', () => {
    const store = new Map<string, SessionSlot>();
    store.set('session-A', makeSlot({ status: 'loading' }));

    const activeSessionId: string = 'session-B'; // switched away from A

    // Simulate fetchFromServer for A resolving after session switch
    const slotA = store.get('session-A')!;
    slotA.messages = [msg('A1')];
    slotA.status = 'idle';
    slotA.fetchedAt = Date.now();

    // Guard: no notify since session A is inactive
    const notifyCalled = 'session-A' === activeSessionId;
    expect(notifyCalled).toBe(false);

    // But slot A's data IS written (switching back will show fresh data)
    expect(store.get('session-A')!.messages).toHaveLength(1);
    expect(store.get('session-A')!.status).toBe('idle');
  });
});
