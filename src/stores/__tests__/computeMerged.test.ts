import { describe, it, expect } from 'vitest';
import { computeMerged } from '../useSessionStore';
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('computeMerged', () => {
  describe('edge cases', () => {
    it('returns server when realtime is empty', () => {
      const server = [msg('s1'), msg('s2')];
      expect(computeMerged(server, [])).toBe(server);
    });

    it('returns realtime when server is empty', () => {
      const realtime = [msg('r1'), msg('r2')];
      expect(computeMerged([], realtime)).toBe(realtime);
    });

    it('returns server when all realtime messages are already in server by ID', () => {
      const server = [msg('a'), msg('b'), msg('c')];
      const realtime = [msg('b'), msg('c')];
      const result = computeMerged(server, realtime);
      expect(result).toBe(server);
    });
  });

  describe('ID-based dedup', () => {
    it('removes realtime messages whose ID is already in server', () => {
      const server = [msg('s1'), msg('s2')];
      const realtime = [msg('s2'), msg('r1')]; // s2 already in server
      const result = computeMerged(server, realtime);
      expect(result.map(m => m.id)).toEqual(['s1', 's2', 'r1']);
    });

    it('appends realtime messages not in server', () => {
      const server = [msg('s1')];
      const realtime = [msg('r1'), msg('r2')];
      const result = computeMerged(server, realtime);
      expect(result.map(m => m.id)).toEqual(['s1', 'r1', 'r2']);
    });
  });

  describe('localMessageId dedup (new behavior)', () => {
    it('removes local_ message from realtime when server has matching localMessageId', () => {
      const server = [
        msg('s1'),
        // server-persisted user message, tagged by backend
        userMsg('uuid-abc_text', 'hello', { localMessageId: 'local_123' }),
        msg('s3'),
      ];
      const realtime = [
        userMsg('local_123', 'hello'), // optimistic copy
        msg('r1'),                     // in-flight tool use
      ];
      const result = computeMerged(server, realtime);
      // local_123 should be dropped; r1 stays
      expect(result.map(m => m.id)).toEqual(['s1', 'uuid-abc_text', 's3', 'r1']);
    });

    it('keeps local_ message when server does NOT yet have matching localMessageId', () => {
      const server = [msg('s1'), msg('s2')];
      const realtime = [userMsg('local_456', 'pending message')];
      const result = computeMerged(server, realtime);
      expect(result.map(m => m.id)).toEqual(['s1', 's2', 'local_456']);
    });

    it('handles multiple local messages in flight, only deduping matched ones', () => {
      const server = [
        userMsg('uuid-1_text', 'first', { localMessageId: 'local_001' }),
        msg('tool-1'),
      ];
      const realtime = [
        userMsg('local_001', 'first'),   // matched → removed
        msg('tool-1'),                   // matched by ID → removed
        userMsg('local_002', 'second'),  // not yet in server → kept
      ];
      const result = computeMerged(server, realtime);
      expect(result.map(m => m.id)).toEqual(['uuid-1_text', 'tool-1', 'local_002']);
    });

    it('deduplication is stable: server order is preserved', () => {
      const server = [
        msg('s1'),
        userMsg('srv-user_text', 'hi', { localMessageId: 'local_999' }),
        msg('s3'),
      ];
      const realtime = [userMsg('local_999', 'hi')];
      const result = computeMerged(server, realtime);
      expect(result).toBe(server); // all realtime deduped → returns server reference
    });
  });

  describe('streaming scenario', () => {
    it('shows streaming messages appended after server during an active run', () => {
      const server = [msg('s1'), msg('s2')]; // historical
      const realtime = [
        userMsg('uuid-user_text', 'my question', { localMessageId: 'local_x' }),
        msg('tool-use-1', { kind: 'tool_use' }),
        msg('stream-delta', { kind: 'stream_delta', content: 'partial...' }),
      ];
      const result = computeMerged(server, realtime);
      // uuid-user_text is the server echo (localMessageId present but not in serverIds or mappedLocalIds from realtime perspective — server doesn't have it yet)
      // All realtime messages appended
      expect(result.map(m => m.id)).toEqual(['s1', 's2', 'uuid-user_text', 'tool-use-1', 'stream-delta']);
    });

    it('after complete+refresh: server has all messages, realtime cleared → merged = server', () => {
      const server = [
        msg('s1'),
        userMsg('uuid-user_text', 'my question', { localMessageId: 'local_x' }),
        msg('tool-use-1', { kind: 'tool_use' }),
        msg('assistant-reply'),
      ];
      const realtime: NormalizedMessage[] = []; // cleared by refreshFromServer
      expect(computeMerged(server, realtime)).toBe(server);
    });
  });

  describe('reconnect scenario', () => {
    it('dedupes local_ message after reconnect when server has localMessageId', () => {
      // Before disconnect: local_x was added to realtime
      // After reconnect: fetchHistory returns server messages with localMessageId tagged
      const serverAfterRefresh = [
        msg('s1'),
        userMsg('uuid-abc_text', 'hello', { localMessageId: 'local_x' }),
        msg('tool-1', { kind: 'tool_use' }),
        msg('assistant-1'),
      ];
      const realtimeAfterReconnect = [
        userMsg('local_x', 'hello'), // stale optimistic message
      ];
      const result = computeMerged(serverAfterRefresh, realtimeAfterReconnect);
      // local_x should be deduped via localMessageId
      expect(result).toBe(serverAfterRefresh);
    });

    it('keeps in-flight realtime messages that are not yet in server', () => {
      const server = [
        msg('s1'),
        userMsg('uuid-abc_text', 'first', { localMessageId: 'local_x' }),
      ];
      const realtime = [
        userMsg('local_x', 'first'),       // deduped
        msg('tool-new', { kind: 'tool_use' }), // still in flight
      ];
      const result = computeMerged(server, realtime);
      expect(result.map(m => m.id)).toEqual(['s1', 'uuid-abc_text', 'tool-new']);
    });
  });
});
