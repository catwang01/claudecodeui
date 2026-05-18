import { useCallback, useMemo, useState } from 'react';

export function useSessionProtection() {
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  const [processingSessionsMap, setProcessingSessionsMap] = useState<Map<string, string>>(new Map());

  const processingSessions = useMemo(() => new Set(processingSessionsMap.keys()), [processingSessionsMap]);

  const markSessionAsActive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => new Set([...prev, sessionId]));
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

  const markSessionAsProcessing = useCallback((sessionId?: string | null, provider = 'claude') => {
    if (!sessionId) {
      return;
    }

    setProcessingSessionsMap((prev) => new Map([...prev, [sessionId, provider]]));
  }, []);

  const batchMarkSessionsAsProcessing = useCallback((entries: Array<{ sessionId: string; provider: string }>) => {
    setProcessingSessionsMap((prev) => {
      const next = new Map(prev);
      for (const { sessionId, provider } of entries) {
        if (sessionId) next.set(sessionId, provider);
      }
      return next;
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
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    batchMarkSessionsAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  };
}
