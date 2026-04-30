import { describe, it, expect } from 'vitest';
import { dedupeMessages, didMessagesChange } from '../useSessionStore';
import type { NormalizedMessage } from '../useSessionStore';

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
