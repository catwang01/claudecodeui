import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useAwaitingPermissions } from '../../../contexts/AwaitingPermissionContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
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
  messageId?: string;
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
  streamTimerRef: MutableRefObject<Map<string, number>>;
  accumulatedStreamMapRef: MutableRefObject<Map<string, string>>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null, provider?: string, startTime?: number | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onPreSessionCreated?: (newSessionId: string) => void;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string) => void;
  onWebSocketReconnect?: () => void;
  onAssistantSpeech?: (text: string) => void;
  onSessionCreationError?: (error: string) => void;
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
  onSessionCreationError,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const { setAwaitingPermission, clearByRequestId, clearSession } = useAwaitingPermissions();
  const { subscribeMessages } = useWebSocket();
  const processedMessagesRef = useRef(new WeakSet<object>());
  const getStreamKey = (sessionId: string, messageId?: string) =>
    messageId ? `${sessionId}::${messageId}` : sessionId;

  // Extracted so we can invoke it BOTH synchronously (from subscribeMessages,
  // for high-frequency streaming) AND via the legacy latestMessage effect
  // (for the initial mount case where a message may have already fired).
  const processMessage = (latestMessage: LatestChatMessage | null | undefined) => {
    if (!latestMessage) return;
    if (typeof latestMessage === 'object') {
      if (processedMessagesRef.current.has(latestMessage)) return;
      processedMessagesRef.current.add(latestMessage);
    }

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
          const isCurrentPermSession = permSessionId === activeViewSessionId;
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

          // Legacy isProcessing format from check-session-status
          const isCurrentSession = statusSessionId === activeViewSessionId;

          const status = msg.status;
          if (status) {
            const statusInfo = {
              text: status.text || 'Working...',
              tokens: status.tokens || 0,
              can_interrupt: status.can_interrupt !== undefined ? status.can_interrupt : true,
            };
            if (isCurrentSession) {
              setClaudeStatus(statusInfo);
              setIsLoading(true);
              setCanAbortSession(statusInfo.can_interrupt);
            }
            return;
          }

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

    const sid = msg.sessionId || null;

    // --- Streaming: buffer for performance ---
    if (msg.kind === 'stream_delta') {
      const text = msg.content || '';
      if (!text || !sid) return;
      const messageId = msg.messageId;
      const streamKey = getStreamKey(sid, messageId);
      const prev = accumulatedStreamMapRef.current.get(streamKey) ?? '';
      accumulatedStreamMapRef.current.set(streamKey, prev + text);
      if (!streamTimerRef.current.has(streamKey)) {
        const timer = window.setTimeout(() => {
          streamTimerRef.current.delete(streamKey);
          sessionStore.updateStreaming(
            sid,
            accumulatedStreamMapRef.current.get(streamKey) ?? '',
            provider,
            messageId,
          );
        }, 100);
        streamTimerRef.current.set(streamKey, timer);
      }
      // NOTE: intentionally do NOT append individual delta frames as
      // standalone messages for background sessions. Each stream_delta is
      // an ephemeral fragment; if we append it, normalizedToChatMessages
      // renders a separate assistant bubble per fragment (e.g. "的",
      // "上一", ".md") because its stream_delta branch turns any delta
      // into an isStreaming assistant message. Accumulation via
      // updateStreaming (which uses a single __streaming_<sid> message
      // id) is the correct path for the current session; for background
      // sessions, the `complete` handler's fetchIncremental will pull the
      // finalized text bubble from the backend.
      return;
    }

    if (msg.kind === 'stream_end') {
      if (sid) {
        const messageId = msg.messageId;
        const streamKey = getStreamKey(sid, messageId);
        const timer = streamTimerRef.current.get(streamKey);
        if (timer) {
          clearTimeout(timer);
          streamTimerRef.current.delete(streamKey);
        }
        const accumulated = accumulatedStreamMapRef.current.get(streamKey) ?? '';
        const finalContent = msg.content || accumulated;
        if (finalContent) {
          sessionStore.updateStreaming(sid, finalContent, provider, messageId);
        }
        sessionStore.finalizeStreaming(sid, messageId);
        if (finalContent) {
          onAssistantSpeech?.(finalContent);
        }
        accumulatedStreamMapRef.current.delete(streamKey);
      }
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
        if (sid) {
          const sessionPrefix = `${sid}::`;
          for (const [streamKey, accumulated] of accumulatedStreamMapRef.current) {
            if (streamKey !== sid && !streamKey.startsWith(sessionPrefix)) continue;
            const timer = streamTimerRef.current.get(streamKey);
            if (timer) {
              clearTimeout(timer);
              streamTimerRef.current.delete(streamKey);
            }
            const messageId = streamKey === sid ? undefined : streamKey.slice(sessionPrefix.length);
            if (accumulated) {
              sessionStore.updateStreaming(sid, accumulated, provider, messageId);
              sessionStore.finalizeStreaming(sid, messageId);
            }
            accumulatedStreamMapRef.current.delete(streamKey);
          }
        }

        const isMySession = !msg.sessionId || msg.sessionId === activeViewSessionId;
        if (isMySession) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          setPendingPermissionRequests([]);
        }
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

        // Reconcile with server to catch any messages the WebSocket may have missed.
        // Delay 500ms to allow the backend JSONL to finish writing.
        if (sid) {
          const lastId = sessionStore.getLastMessageId(sid);
          setTimeout(() => {
            if (lastId) {
              sessionStore.fetchIncremental(sid, lastId, {
                provider,
                projectName: selectedProject?.name,
                projectPath: selectedProject?.fullPath || selectedProject?.path || '',
              });
            } else {
              // Store was cleared (e.g. by navigation during session creation) — do a full refresh
              // so assistant messages written after clearSlot are not lost.
              sessionStore.fetchFromServer(sid, {
                provider,
                projectName: selectedProject?.name,
                projectPath: selectedProject?.fullPath || selectedProject?.path || '',
              });
            }
          }, 500);
        }
        break;
      }

      case 'error': {
        const isMySession = !msg.sessionId || msg.sessionId === activeViewSessionId;
        if (isMySession) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          onSessionCreationError?.(msg.error || 'Session creation failed');
        }
        onSessionInactive?.(sid);
        if (sid) clearSession(sid);
        onSessionNotProcessing?.(sid);
        break;
      }

      case 'permission_request': {
        if (!msg.requestId) break;
        // Always register in global context (drives sidebar badge for background sessions)
        if (sid) {
          setAwaitingPermission(sid, { toolName: msg.toolName ?? '', requestId: msg.requestId ?? '' });
        }
        // Only update local UI state if this request belongs to the current session
        const isMySession = !msg.sessionId || msg.sessionId === activeViewSessionId;
        if (isMySession) {
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
          setIsLoading(true);
          setCanAbortSession(true);
          setClaudeStatus({ text: 'Waiting for permission', tokens: 0, can_interrupt: true });
        }
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
        const isMySession = !msg.sessionId || msg.sessionId === activeViewSessionId;
        if (msg.text === 'token_budget' && msg.tokenBudget) {
          if (isMySession) setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        } else if (msg.text === 'context_mgmt_retry') {
          const sid = msg.sessionId || activeViewSessionId;
          if (sid) {
            sessionStore.appendWsMessage(sid, {
              id: `context-mgmt-retry-${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider: (msg.provider as NormalizedMessage['provider']) || 'claude',
              kind: 'text',
              role: 'assistant',
              content: `⟳ Context compaction failed, retrying (${msg.retryCount}/${msg.maxRetries})...`,
            } as NormalizedMessage);
          }
          if (isMySession) {
            setClaudeStatus({
              text: `Retrying context compaction (${msg.retryCount}/${msg.maxRetries})`,
              tokens: 0,
              can_interrupt: true,
            });
            setIsLoading(true);
            setCanAbortSession(true);
          }
        } else if (msg.text === 'stall_retry') {
          if (isMySession) {
            const errSuffix = msg.errorMessage ? `: ${msg.errorMessage}` : '';
            setClaudeStatus({
              text: `Reconnecting (${msg.retryCount}/${msg.maxRetries})${errSuffix}`,
              tokens: 0,
              can_interrupt: true,
            });
            setIsLoading(true);
            setCanAbortSession(true);
          }
        } else if (msg.text) {
          if (isMySession) {
            setClaudeStatus({
              text: msg.text,
              tokens: msg.tokens || 0,
              can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
            });
            setIsLoading(true);
            setCanAbortSession(msg.canInterrupt !== false);
          }
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
  };

  // We store processMessage in a ref so the subscribe effect below doesn't need
  // to be re-run every time props change — which would tear down and rebuild
  // the WS listener on every render, and could miss messages in between.
  const processMessageRef = useRef(processMessage);
  processMessageRef.current = processMessage;

  // Legacy path: honor an already-set latestMessage from the context (e.g. on
  // first mount when the WS message arrived before this hook subscribed).
  useEffect(() => {
    processMessageRef.current(latestMessage);
  }, [latestMessage]);

  // Streaming-safe path: subscribe synchronously to WS messages so a burst
  // of stream_delta events in the same React batch never collapses into one.
  useEffect(() => {
    const unsub = subscribeMessages((msg) => processMessageRef.current(msg));
    return unsub;
  }, [subscribeMessages]);

  // Clean up the accumulated stream map entry when the session changes or component unmounts
  useEffect(() => {
    const sid = currentSessionId;
    const accumulatedStreamMap = accumulatedStreamMapRef.current;
    const streamTimers = streamTimerRef.current;
    return () => {
      if (sid) {
        const sessionPrefix = `${sid}::`;
        for (const streamKey of accumulatedStreamMap.keys()) {
          if (streamKey === sid || streamKey.startsWith(sessionPrefix)) {
            accumulatedStreamMap.delete(streamKey);
            const timer = streamTimers.get(streamKey);
            if (timer) clearTimeout(timer);
            streamTimers.delete(streamKey);
          }
        }
      }
    };
  }, [currentSessionId, accumulatedStreamMapRef, streamTimerRef]);
}
