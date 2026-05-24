// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { normalizeMessage } from './adapter.js';

// normalizeMessage imports getSessionMessages from ../../projects.js via fetchHistory,
// but normalizeMessage itself is a pure synchronous function — no I/O, safe to import directly.

describe('normalizeMessage', () => {
  const SESSION_ID = 'test-session-id';

  it('returns empty array for type:attachment entries (hook events)', () => {
    const raw = {
      parentUuid: 'bd2f5b0d-2a5c-4e69-b559-9269d4087104',
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        hookName: 'SessionStart:compact',
        hookEvent: 'SessionStart',
        content: '',
        stdout: '{}',
        stderr: '',
        exitCode: 0,
      },
      uuid: 'afea7c36-1a56-4ad1-83a0-f747180db4a7',
      timestamp: '2026-05-16T20:08:56.954Z',
      sessionId: SESSION_ID,
    };

    const result = normalizeMessage(raw, SESSION_ID);

    expect(result).toEqual([]);
  });

  it('returns empty array for type:attachment with hook_failure', () => {
    const raw = {
      type: 'attachment',
      attachment: {
        type: 'hook_failure',
        hookName: 'UserPromptSubmit',
        exitCode: 1,
        stderr: 'some error',
      },
      uuid: 'some-uuid',
      timestamp: '2026-05-16T20:08:56.954Z',
      sessionId: SESSION_ID,
    };

    expect(normalizeMessage(raw, SESSION_ID)).toEqual([]);
  });

  it('filters out "This session is being continued" user messages', () => {
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: ...',
      },
      uuid: 'test-uuid',
      timestamp: '2026-05-16T20:00:00.000Z',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      sessionId: SESSION_ID,
    };

    expect(normalizeMessage(raw, SESSION_ID)).toEqual([]);
  });

  it('returns a text message for regular user messages', () => {
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: 'Hello, how are you?',
      },
      uuid: 'test-uuid-2',
      timestamp: '2026-05-16T20:01:00.000Z',
      sessionId: SESSION_ID,
    };

    const result = normalizeMessage(raw, SESSION_ID);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('text');
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('Hello, how are you?');
  });
});
