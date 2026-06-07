import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { Project, ProjectSession } from '../../../types/app';
import { SHELL_PING_INTERVAL_MS, TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';
import { getClaudeSettings } from '../../chat/utils/chatStorage';
import { logger } from '../../../utils/logger';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  setAuthUrl: (nextAuthUrl: string) => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  closeSocket: () => void;
  connectToShell: () => void;
  disconnectFromShell: () => void;
  markUserDisconnected: () => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  setAuthUrl,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const connectingRef = useRef(false);
  const userDisconnectedRef = useRef(false);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        logger.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        const term = terminalRef.current;
        if (term) {
          // Use the write callback so scrollToBottom runs after xterm has
          // actually rendered the new rows — calling it synchronously would
          // scroll before the content is in the viewport.
          term.write(output, () => term.scrollToBottom());
        }
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'auth_url' || message.type === 'url_open') {
        const nextAuthUrl = typeof message.url === 'string' ? message.url : '';
        if (nextAuthUrl) {
          setAuthUrl(nextAuthUrl);
        }
      }
    },
    [handleProcessCompletion, onOutputRef, setAuthUrl, terminalRef],
  );

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl();
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;
          setAuthUrl('');

          window.setTimeout(() => {
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            currentFitAddon.fit();

            sendSocketMessage(socket, {
              type: 'init',
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || localStorage.getItem('selected-provider') || 'claude'),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              skipPermissions: getClaudeSettings().skipPermissions,
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          // Intentionally NOT calling clearTerminalScreen() here so that
          // existing terminal content remains visible when the socket drops
          // (e.g. while the shell tab is hidden). The server replays buffered
          // output on reconnect, so the user won't miss anything.
        };

        socket.onerror = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
      }
    },
    [
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      setAuthUrl,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback(() => {
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    userDisconnectedRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const markUserDisconnected = useCallback(() => {
    userDisconnectedRef.current = true;
  }, []);

  const disconnectFromShell = useCallback(() => {
    // NOTE: does NOT set userDisconnectedRef — callers that want to block
    // auto-reconnect (user-initiated disconnect) should call markUserDisconnected first.
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    setAuthUrl('');
  }, [clearTerminalScreen, closeSocket, setAuthUrl]);

  useEffect(() => {
    if (!autoConnect || !isInitialized || isConnecting || isConnected || userDisconnectedRef.current) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

  // Keepalive: send a ping every SHELL_PING_INTERVAL_MS while connected to
  // prevent network/proxy idle-timeout from silently dropping the WebSocket
  // (especially important for background sessions that have no user activity).
  useEffect(() => {
    if (!isConnected) {
      return;
    }

    const pingInterval = window.setInterval(() => {
      sendSocketMessage(wsRef.current, { type: 'ping' });
    }, SHELL_PING_INTERVAL_MS);

    return () => {
      window.clearInterval(pingInterval);
    };
  }, [isConnected, wsRef]);

  return {
    isConnected,
    isConnecting,
    closeSocket,
    connectToShell,
    disconnectFromShell,
    markUserDisconnected,
  };
}
