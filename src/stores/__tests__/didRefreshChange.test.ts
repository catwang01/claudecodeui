import { describe, it, expect } from 'vitest';
import { didRefreshChange } from '../useSessionStore';
import type { NormalizedMessage } from '../useSessionStore';

function msg(id: string): NormalizedMessage {
  return {
    id,
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: `content-${id}`,
  };
}

describe('didRefreshChange', () => {
  it('returns false when nothing changed', () => {
    const messages = [msg('a'), msg('b'), msg('c')];
    expect(didRefreshChange(messages, messages, 0, 0)).toBe(false);
  });

  it('returns false when new array has same IDs in same order', () => {
    const prev = [msg('a'), msg('b'), msg('c')];
    const next = [msg('a'), msg('b'), msg('c')];
    expect(didRefreshChange(prev, next, 0, 0)).toBe(false);
  });

  it('returns true when message count increases', () => {
    const prev = [msg('a'), msg('b'), msg('c')];
    const next = [msg('a'), msg('b'), msg('c'), msg('d')];
    expect(didRefreshChange(prev, next, 0, 0)).toBe(true);
  });

  it('returns true when message count decreases', () => {
    const prev = [msg('a'), msg('b'), msg('c')];
    const next = [msg('a'), msg('b')];
    expect(didRefreshChange(prev, next, 0, 0)).toBe(true);
  });

  it('returns true when last message id changed (same count)', () => {
    const prev = [msg('a'), msg('b'), msg('c')];
    const next = [msg('a'), msg('b'), msg('new-c')];
    expect(didRefreshChange(prev, next, 0, 0)).toBe(true);
  });

  it('returns true when a middle message id changed', () => {
    const prev = [msg('a'), msg('b'), msg('c')];
    const next = [msg('a'), msg('new-b'), msg('c')];
    expect(didRefreshChange(prev, next, 0, 0)).toBe(true);
  });

  it('returns true when a realtime message was cleared', () => {
    const messages = [msg('a'), msg('b')];
    expect(didRefreshChange(messages, messages, 1, 0)).toBe(true);
  });

  it('returns false for empty-to-empty', () => {
    expect(didRefreshChange([], [], 0, 0)).toBe(false);
  });

  it('returns true when going from empty to non-empty', () => {
    const next = [msg('a')];
    expect(didRefreshChange([], next, 0, 0)).toBe(true);
  });
});
