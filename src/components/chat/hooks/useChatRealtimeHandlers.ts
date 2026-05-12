import { useEffect, useRef } from 'react';
import { useAwaitingPermissions } from '../../../contexts/AwaitingPermissionContext';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { PendingPermissionRequest } from '../types/types';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

type LatestChatMessage = {
  type?: string;
  kind?: string;
  data?: any;
  message?: any;
  delta?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  error?: string;
  tool?: any;
  toolId?: string;
  result?: any;
  exitCode?: number;
  isProcessing?: boolean;
  actualSessionId?: string;
  event?: string;
  status?: any;
  isNewSession?: boolean;
  resultText?: string;
  isError?: boolean;
  success?: boolean;
  reason?: string;
  provider?: string;
  content?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  newSessionId?: string;
  aborted?: boolean;
  startTime?: number | null;
  [key: string]: any;
};

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null;
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  streamBufferRef: MutableRefObject<string>;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamMapRef: MutableRefObject<Map<string, string>>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null, provider?: string, startTime?: number | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onPreSessionCreated?: (newSessionId: string) => void;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string) => void;
  onWebSocketReconnect?: () => void;
  onAssistantSpeech?: (text: string) => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatRealtimeHandlers({
  latestMessage,
  provider,
  selectedProject,
  selectedSession,
  currentSessionId,
  setCurrentSessionId,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setTokenBudget,
  setPendingPermissionRequests,
  pendingViewSessionRef,
  streamBufferRef,
  streamTimerRef,
  accumulatedStreamMapRef,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onPreSessionCreated,
  onReplaceTemporarySession,
  onNavigateToSession,
  onWebSocketReconnect,
  onAssistantSpeech,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const { setAwaitingPermission, clearByRequestId, clearSession } = useAwaitingPermissions();
  const lastProcessedMessageRef = useRef<LatestChatMessage | null>(null);

  useEffect(() => {
    if (!latestMessage) return;
    if (lastProcessedMessageRef.current === latestMessage) return;
    lastProcessedMessageRef.current = latestMessage;

    const activeViewSessionId =
      selectedSession?.id || currentSessionId || pendingViewSessionRef.current?.sessionId || null;

    /* ---------------------------------------------------------------- */
    /*  Legacy messages (no `kind` field) — handle and return           */
    /* ---------------------------------------------------------------- */

    const msg = latestMessage as any;

    if (!msg.kind) {
      const messageType = String(msg.type || '');

      switch (messageType) {
        case 'websocket-reconnected':
          onWebSocketReconnect?.();
          return;

        case 'pending-permissions-response': {
          const permSessionId = msg.sessionId;
          const isCurrentPermSession =
            permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
          if (permSessionId && !isCurrentPermSession) return;
          const requests: PendingPermissionRequest[] = msg.data || [];
          setPendingPermissionRequests(requests);
          // Restore amber badge and toast after WS reconnect
          for (const req of requests) {
            if (req.sessionId && req.requestId) {
              setAwaitingPermission(req.sessionId, { toolName: req.toolName || '', requestId: req.requestId });
            }
          }
          return;
        }

        case 'session-status': {
          const statusSessionId = msg.sessionId;
          if (!statusSessionId) return;

          const status = msg.status;
          if (status) {
            const statusInfo = {
              text: status.text || 'Working...',
              tokens: status.tokens || 0,
              can_interrupt: status.can_interrupt !== undefined ? status.can_interrupt : true,
            };
            setClaudeStatus(statusInfo);
            setIsLoading(true);
            setCanAbortSession(statusInfo.can_interrupt);
            return;
          }

          // Legacy isProcessing format from check-session-status
          const isCurrentSession =
            statusSessionId === currentSessionId || (selectedSession && statusSessionId === selectedSession.id);

          if (msg.isProcessing) {
            onSessionProcessing?.(statusSessionId, msg.provider, msg.startTime ?? null);
            if (isCurrentSession) { setIsLoading(true); setCanAbortSession(true); }
            return;
          }
          onSessionInactive?.(statusSessionId);
          onSessionNotProcessing?.(statusSessionId);
          if (isCurrentSession) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }
          return;
        }

        case 'projects_updated': {
          // If the server included a message delta, append it to the affected session's store.
          // This replaces the old externalMessageUpdate → refreshFromServer REST round-trip.
          const { changedSessionId, newMessages: deltaMessages } = msg as {
            changedSessionId?: string;
            newMessages?: import('../../../stores/useSessionStore').NormalizedMessage[];
          };
          if (changedSessionId && Array.isArray(deltaMessages) && deltaMessages.length > 0) {
            sessionStore.appendWsMessageBatch(changedSessionId, deltaMessages);
          }
          return;
        }

        default:
          // Unknown legacy message type — ignore
          return;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  NormalizedMessage handling (has `kind` field)                    */
    /* ---------------------------------------------------------------- */

    const sid = msg.sessionId || activeViewSessionId;

    // --- Streaming: buffer for performance ---
    if (msg.kind === 'stream_delta') {
      const text = msg.content || '';
      if (!text) return;
      streamBufferRef.current += text;
      if (sid) {
        const prev = accumulatedStreamMapRef.current.get(sid) ?? '';
        accumulatedStreamMapRef.current.set(sid, prev + text);
      }
      if (!streamTimerRef.current) {
        streamTimerRef.current = window.setTimeout(() => {
          streamTimerRef.current = null;
          if (sid) {
            sessionStore.updateStreaming(sid, accumulatedStreamMapRef.current.get(sid) ?? '', provider);
          }
        }, 100);
      }
      // Also route to store for non-active sessions
      if (sid && sid !== activeViewSessionId) {
        sessionStore.appendWsMessage(sid, msg as NormalizedMessage);
      }
      return;
    }

    if (msg.kind === 'stream_end') {
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      if (sid) {
        const accumulated = accumulatedStreamMapRef.current.get(sid) ?? '';
        if (accumulated) {
          sessionStore.updateStreaming(sid, accumulated, provider);
        }
        sessionStore.finalizeStreaming(sid);
        if (accumulated) {
          onAssistantSpeech?.(accumulated);
        }
        accumulatedStreamMapRef.current.delete(sid);
      }
      streamBufferRef.current = '';
      return;
    }

    // --- All other messages: route to store (skip control-only events) ---
    const CONTROL_KINDS = new Set(['complete', 'status', 'permission_request', 'permission_cancelled', 'session_created']);
    if (sid && !CONTROL_KINDS.has(msg.kind)) {
      sessionStore.appendWsMessage(sid, msg as NormalizedMessage);
    }

    // --- UI side effects for specific kinds ---
    switch (msg.kind) {
      case 'session_created': {
        const newSessionId = msg.newSessionId;
        if (!newSessionId) break;

        if (!currentSessionId || currentSessionId.startsWith('new-session-')) {
          sessionStorage.setItem('pendingSessionId', newSessionId);
          if (pendingViewSessionRef.current && !pendingViewSessionRef.current.sessionId) {
            pendingViewSessionRef.current.sessionId = newSessionId;
          }
          setCurrentSessionId(newSessionId);
          onPreSessionCreated?.(newSessionId);
          onReplaceTemporarySession?.(newSessionId);
          setPendingPermissionRequests((prev) =>
            prev.map((r) => (r.sessionId ? r : { ...r, sessionId: newSessionId })),
          );
        }
        onNavigateToSession?.(newSessionId);
        break;
      }

      case 'complete': {
        // Flush any remaining streaming state
        if (streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        if (sid) {
          const accumulated = accumulatedStreamMapRef.current.get(sid) ?? '';
          if (accumulated) {
            sessionStore.updateStreaming(sid, accumulated, provider);
            sessionStore.finalizeStreaming(sid);
          }
          accumulatedStreamMapRef.current.delete(sid);
        }
        streamBufferRef.current = '';

        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
        setPendingPermissionRequests([]);
        onSessionInactive?.(sid);
        if (sid) clearSession(sid);
        onSessionNotProcessing?.(sid);

        // Handle aborted case
        if (msg.aborted) {
          // Abort was requested — the complete event confirms it
          // No special UI action needed beyond clearing loading state above
          // The backend already sent any abort-related messages
          break;
        }

        // Clear pending session
        const pendingSessionId = sessionStorage.getItem('pendingSessionId');
        if (pendingSessionId && !currentSessionId && msg.exitCode === 0) {
          const actualId = msg.actualSessionId || pendingSessionId;
          setCurrentSessionId(actualId);
          if (msg.actualSessionId) {
            onNavigateToSession?.(actualId);
          }
          sessionStorage.removeItem('pendingSessionId');
          if (window.refreshProjects) {
            setTimeout(() => window.refreshProjects?.(), 500);
          }
        }
        break;
      }

      case 'error': {
        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
        onSessionInactive?.(sid);
        if (sid) clearSession(sid);
        onSessionNotProcessing?.(sid);
        break;
      }

      case 'permission_request': {
        if (!msg.requestId) break;
        setPendingPermissionRequests((prev) => {
          if (prev.some((r: PendingPermissionRequest) => r.requestId === msg.requestId)) return prev;
          return [...prev, {
            requestId: msg.requestId,
            toolName: msg.toolName || 'UnknownTool',
            input: msg.input,
            context: msg.context,
            sessionId: sid || null,
            receivedAt: new Date(),
          }];
        });
        if (sid) {
          setAwaitingPermission(sid, { toolName: msg.toolName ?? '', requestId: msg.requestId ?? '' });
        }
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({ text: 'Waiting for permission', tokens: 0, can_interrupt: true });
        break;
      }

      case 'permission_cancelled': {
        if (msg.requestId) {
          setPendingPermissionRequests((prev) => prev.filter((r: PendingPermissionRequest) => r.requestId !== msg.requestId));
          clearByRequestId(msg.requestId);
        }
        break;
      }

      case 'status': {
        if (msg.text === 'token_budget' && msg.tokenBudget) {
          setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        } else if (msg.text) {
          setClaudeStatus({
            text: msg.text,
            tokens: msg.tokens || 0,
            can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
          });
          setIsLoading(true);
          setCanAbortSession(msg.canInterrupt !== false);
        }
        break;
      }

      // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
      // → already routed to store above, no UI side effects needed
      default:
        // Speak non-streaming assistant text messages
        if (msg.kind === 'text' && msg.role !== 'user' && msg.content) {
          onAssistantSpeech?.(msg.content);
        }
        break;
    }
  }, [
    latestMessage,
    provider,
    selectedProject,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    streamBufferRef,
    streamTimerRef,
    accumulatedStreamMapRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onPreSessionCreated,
    onReplaceTemporarySession,
    onNavigateToSession,
    onWebSocketReconnect,
    onAssistantSpeech,
    sessionStore,
    setAwaitingPermission,
    clearByRequestId,
    clearSession,
  ]);

  // Clean up the accumulated stream map entry when the session changes or component unmounts
  useEffect(() => {
    const sid = currentSessionId;
    return () => {
      if (sid) {
        accumulatedStreamMapRef.current.delete(sid);
      }
    };
  }, [currentSessionId, accumulatedStreamMapRef]);
}
