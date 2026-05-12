import React, { createContext, useCallback, useContext, useState } from 'react';

export interface AwaitingPermissionEntry {
  toolName: string;
  requestId: string;
}

interface AwaitingPermissionContextValue {
  awaitingPermissionSessions: Map<string, AwaitingPermissionEntry[]>;
  setAwaitingPermission: (sessionId: string, entry: AwaitingPermissionEntry) => void;
  clearByRequestId: (requestId: string) => void;
  clearSession: (sessionId: string) => void;
}

const AwaitingPermissionContext = createContext<AwaitingPermissionContextValue | null>(null);

export function AwaitingPermissionProvider({ children }: { children: React.ReactNode }) {
  const [map, setMap] = useState<Map<string, AwaitingPermissionEntry[]>>(() => new Map());

  const setAwaitingPermission = useCallback((sessionId: string, entry: AwaitingPermissionEntry) => {
    setMap((prev) => {
      const next = new Map(prev);
      const existing = next.get(sessionId) ?? [];
      if (existing.some((e) => e.requestId === entry.requestId)) return prev;
      next.set(sessionId, [...existing, entry]);
      return next;
    });
  }, []);

  const clearByRequestId = useCallback((requestId: string) => {
    setMap((prev) => {
      const next = new Map(prev);
      for (const [sessionId, entries] of next) {
        const filtered = entries.filter((e) => e.requestId !== requestId);
        if (filtered.length === 0) {
          next.delete(sessionId);
        } else {
          next.set(sessionId, filtered);
        }
      }
      return next;
    });
  }, []);

  const clearSession = useCallback((sessionId: string) => {
    setMap((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  return (
    <AwaitingPermissionContext.Provider value={{ awaitingPermissionSessions: map, setAwaitingPermission, clearByRequestId, clearSession }}>
      {children}
    </AwaitingPermissionContext.Provider>
  );
}

export function useAwaitingPermissions(): AwaitingPermissionContextValue {
  const ctx = useContext(AwaitingPermissionContext);
  if (!ctx) throw new Error('useAwaitingPermissions must be used within AwaitingPermissionProvider');
  return ctx;
}
