import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSessionProtection } from '../useSessionProtection';

describe('useSessionProtection', () => {
  it('keeps shell processing out of the chat processing set', () => {
    const { result } = renderHook(() => useSessionProtection());

    act(() => {
      result.current.markShellSessionAsProcessing('copilot-shell-session');
    });

    expect(result.current.processingSessions).toEqual(new Set(['copilot-shell-session']));
    expect(result.current.chatProcessingSessions).toEqual(new Set());
  });

  it('includes SDK processing in both chat and sidebar processing sets', () => {
    const { result } = renderHook(() => useSessionProtection());

    act(() => {
      result.current.markSessionAsProcessing('copilot-chat-session', 'copilot', 1234);
    });

    expect(result.current.chatProcessingSessions).toEqual(new Set(['copilot-chat-session']));
    expect(result.current.processingSessions).toEqual(new Set(['copilot-chat-session']));
  });
});
