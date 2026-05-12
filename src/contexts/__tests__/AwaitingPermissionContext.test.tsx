// src/contexts/__tests__/AwaitingPermissionContext.test.tsx
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AwaitingPermissionProvider, useAwaitingPermissions } from '../AwaitingPermissionContext';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AwaitingPermissionProvider>{children}</AwaitingPermissionProvider>
);

test('starts with empty map', () => {
  const { result } = renderHook(() => useAwaitingPermissions(), { wrapper });
  expect(result.current.awaitingPermissionSessions.size).toBe(0);
});

test('setAwaitingPermission adds entry for session', () => {
  const { result } = renderHook(() => useAwaitingPermissions(), { wrapper });
  act(() => {
    result.current.setAwaitingPermission('session-1', { toolName: 'Bash', requestId: 'req-1' });
  });
  expect(result.current.awaitingPermissionSessions.get('session-1')).toEqual([
    { toolName: 'Bash', requestId: 'req-1' },
  ]);
});

test('setAwaitingPermission deduplicates by requestId', () => {
  const { result } = renderHook(() => useAwaitingPermissions(), { wrapper });
  act(() => {
    result.current.setAwaitingPermission('session-1', { toolName: 'Bash', requestId: 'req-1' });
    result.current.setAwaitingPermission('session-1', { toolName: 'Bash', requestId: 'req-1' });
  });
  expect(result.current.awaitingPermissionSessions.get('session-1')!.length).toBe(1);
});

test('clearByRequestId removes entry across sessions', () => {
  const { result } = renderHook(() => useAwaitingPermissions(), { wrapper });
  act(() => {
    result.current.setAwaitingPermission('session-1', { toolName: 'Bash', requestId: 'req-1' });
    result.current.setAwaitingPermission('session-2', { toolName: 'Read', requestId: 'req-2' });
  });
  act(() => {
    result.current.clearByRequestId('req-1');
  });
  expect(result.current.awaitingPermissionSessions.has('session-1')).toBe(false);
  expect(result.current.awaitingPermissionSessions.get('session-2')!.length).toBe(1);
});

test('clearByRequestId removes session key when no entries remain', () => {
  const { result } = renderHook(() => useAwaitingPermissions(), { wrapper });
  act(() => {
    result.current.setAwaitingPermission('session-1', { toolName: 'Bash', requestId: 'req-1' });
  });
  act(() => {
    result.current.clearByRequestId('req-1');
  });
  expect(result.current.awaitingPermissionSessions.has('session-1')).toBe(false);
});

test('clearSession removes all entries for a session', () => {
  const { result } = renderHook(() => useAwaitingPermissions(), { wrapper });
  act(() => {
    result.current.setAwaitingPermission('session-1', { toolName: 'Bash', requestId: 'req-1' });
    result.current.setAwaitingPermission('session-1', { toolName: 'Read', requestId: 'req-2' });
  });
  act(() => {
    result.current.clearSession('session-1');
  });
  expect(result.current.awaitingPermissionSessions.has('session-1')).toBe(false);
});

test('useAwaitingPermissions throws outside provider', () => {
  expect(() => renderHook(() => useAwaitingPermissions())).toThrow(
    'useAwaitingPermissions must be used within AwaitingPermissionProvider',
  );
});
