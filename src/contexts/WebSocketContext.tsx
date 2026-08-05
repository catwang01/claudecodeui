import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { logger } from '../utils/logger';

type MessageListener = (message: any) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  /**
   * The most recent WebSocket message we received. Kept for backwards
   * compatibility with consumers that only care about occasional / low-rate
   * events (loading_progress, projects_updated, active-sessions).
   *
   * WARNING: high-frequency streams (Copilot stream_delta) can arrive multiple
   * times in a single React batch, in which case `latestMessage` only reflects
   * the last one and intermediate messages are lost. For anything streaming,
   * subscribe via `subscribeMessages` instead.
   */
  latestMessage: any | null;
  /**
   * Register a listener that is invoked synchronously on every incoming WS
   * message, before React batches state updates. This guarantees no
   * intermediate messages are dropped when many messages arrive in the same
   * event-loop tick (which is what caused Copilot streaming to lose
   * characters when React 18 collapsed a burst of setLatestMessage calls into
   * one).
   *
   * Returns an unsubscribe function.
   */
  subscribeMessages: (listener: MessageListener) => () => void;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();

  // Set-of-listener refs are kept out of React state so subscribe/unsubscribe
  // doesn't trigger re-renders of the provider tree.
  const listenersRef = useRef<Set<MessageListener>>(new Set());

  const subscribeMessages = useCallback((listener: MessageListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const dispatchToListeners = useCallback((data: any) => {
    // Copy defensively — listeners may unsubscribe during iteration.
    for (const l of Array.from(listenersRef.current)) {
      try { l(data); } catch (err) { logger.error('[WS] listener error:', err); }
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false; // Reset on each effect run (cleanup fires on deps change too, not just unmount)
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [token]); // everytime token changes, we reconnect

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return logger.warn('No authentication token found for WebSocket connection');
      
      const websocket = new WebSocket(wsUrl);
      // Set immediately so onclose guards can detect stale events from replaced sockets
      wsRef.current = websocket;

      websocket.onopen = () => {
        if (wsRef.current !== websocket) return; // Stale open: a newer socket replaced us
        setIsConnected(true);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          logger.log('[WS] Reconnected at', new Date().toISOString());
          const reconnectMsg = { type: 'websocket-reconnected', timestamp: Date.now() };
          dispatchToListeners(reconnectMsg);
          setLatestMessage(reconnectMsg);
        } else {
          logger.log('[WS] Connected (first time) at', new Date().toISOString());
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        if (wsRef.current !== websocket) return; // Stale message from replaced socket
        try {
          const data = JSON.parse(event.data);
          if (data.type !== 'loading_progress') {
            logger.log('[WS] message kind=%s type=%s', data.kind ?? '-', data.type ?? '-', data);
          }
          // Dispatch to synchronous listeners FIRST so streaming consumers
          // (Copilot stream_delta) see every message even when several land
          // in the same React batch.
          dispatchToListeners(data);
          setLatestMessage(data);
        } catch (error) {
          logger.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) return; // Stale close: a newer socket already took over, ignore
        setIsConnected(false);
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        logger.error('WebSocket error:', error);
      };

    } catch (error) {
      logger.error('Error creating WebSocket connection:', error);
    }
  }, [token]); // everytime token changes, we reconnect

  const sendMessage = useCallback((message: any) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      logger.warn('WebSocket not connected');
    }
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    subscribeMessages,
    isConnected
  }), [sendMessage, latestMessage, subscribeMessages, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
