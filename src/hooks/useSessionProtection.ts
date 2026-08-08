import { useCallback, useMemo, useState } from 'react';

export type ProcessingSessionInfo = {
  provider: string;
  startTime: number;
};

export function useSessionProtection() {
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  const [processingSessionsMap, setProcessingSessionsMap] = useState<Map<string, ProcessingSessionInfo>>(new Map());
  // Shell processing is tracked separately so chat status updates (check-session-status /
  // session-status WS messages) cannot clear shell's processing indicator and vice versa.
  const [shellProcessingSessions, setShellProcessingSessions] = useState<Map<string, number>>(new Map());

  // processingSessions is the union of chat and shell — used by the sidebar to show
  // the activity indicator for any session that is processing in any mode.
  const processingSessions = useMemo(
    () => new Set([...processingSessionsMap.keys(), ...shellProcessingSessions.keys()]),
    [processingSessionsMap, shellProcessingSessions],
  );

  const processingSessionStartTimes = useMemo(() => {
    const startTimes = new Map<string, number>();
    for (const [sessionId, info] of processingSessionsMap) {
      startTimes.set(sessionId, info.startTime);
    }
    for (const [sessionId, startTime] of shellProcessingSessions) {
      startTimes.set(sessionId, Math.max(startTimes.get(sessionId) ?? 0, startTime));
    }
    return startTimes;
  }, [processingSessionsMap, shellProcessingSessions]);

  const markSessionAsActive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }
    setActiveSessions((prev) => {
      if (prev.has(sessionId)) return prev; // no-op if already present
      return new Set([...prev, sessionId]);
    });
  }, []);

  const markSessionAsInactive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  // Chat-side processing (driven by Claude SDK status / check-session-status)
  const markSessionAsProcessing = useCallback((
    sessionId?: string | null,
    provider = 'claude',
    startTime?: number | null,
  ) => {
    if (!sessionId) {
      return;
    }
    // No-op if already tracked with the same provider — avoids creating a new Map
    // reference every 5 seconds from the check-sessions-status poll, which would
    // cause processingSessions to rebuild and all SidebarProjectItem to re-render.
    setProcessingSessionsMap((prev) => {
      const existing = prev.get(sessionId);
      const resolvedStartTime = typeof startTime === 'number' && Number.isFinite(startTime)
        ? startTime
        : existing?.startTime ?? Date.now();
      if (existing?.provider === provider && existing.startTime === resolvedStartTime) return prev;
      return new Map([...prev, [sessionId, { provider, startTime: resolvedStartTime }]]);
    });
  }, []);

  const batchMarkSessionsAsProcessing = useCallback((
    entries: Array<{ sessionId: string; provider: string; startTime?: number | null }>,
  ) => {
    setProcessingSessionsMap((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const { sessionId, provider, startTime } of entries) {
        const existing = prev.get(sessionId);
        const resolvedStartTime = typeof startTime === 'number' && Number.isFinite(startTime)
          ? startTime
          : existing?.startTime ?? Date.now();
        if (sessionId && (existing?.provider !== provider || existing.startTime !== resolvedStartTime)) {
          next.set(sessionId, { provider, startTime: resolvedStartTime });
          changed = true;
        }
      }
      // Return same reference if nothing changed
      return changed ? next : prev;
    });
  }, []);

  const markSessionAsNotProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessionsMap((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  // Shell-side processing (driven by terminal output analysis in Shell.tsx)
  const markShellSessionAsProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }
    setShellProcessingSessions((prev) => {
      if (prev.has(sessionId)) return prev; // no-op if already present
      return new Map([...prev, [sessionId, Date.now()]]);
    });
  }, []);

  const markShellSessionAsNotProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setShellProcessingSessions((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const replaceTemporarySession = useCallback((realSessionId?: string | null) => {
    if (!realSessionId) {
      return;
    }

    setActiveSessions((prev) => {
      const next = new Set<string>();
      for (const sessionId of prev) {
        if (!sessionId.startsWith('new-session-')) {
          next.add(sessionId);
        }
      }
      next.add(realSessionId);
      return next;
    });
  }, []);

  return {
    activeSessions,
    processingSessions,
    processingSessionsMap,
    processingSessionStartTimes,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    batchMarkSessionsAsProcessing,
    markSessionAsNotProcessing,
    markShellSessionAsProcessing,
    markShellSessionAsNotProcessing,
    replaceTemporarySession,
  };
}
