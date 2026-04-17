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
    markSessionAsNotProcessing,
    replaceTemporarySession,
  };
}
