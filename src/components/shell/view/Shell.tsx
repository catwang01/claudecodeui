import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@xterm/xterm/css/xterm.css';
import type { Project, ProjectSession } from '../../../types/app';
import {
  PROMPT_BUFFER_SCAN_LINES,
  PROMPT_DEBOUNCE_MS,
  PROMPT_MAX_OPTIONS,
  PROMPT_MIN_OPTIONS,
  PROMPT_OPTION_SCAN_LINES,
  SHELL_IDLE_CONFIRM_MS,
  SHELL_IDLE_CONFIRM_REQUIRED,
  SHELL_IDLE_DETECT_MS,
  SHELL_IDLE_MAX_RETRIES,
  SHELL_IDLE_RETRY_MS,
  SHELL_RESTART_DELAY_MS,
} from '../constants/constants';
import { useShellRuntime } from '../hooks/useShellRuntime';
import { sendSocketMessage } from '../utils/socket';
import { getSessionDisplayName } from '../utils/auth';
import ShellConnectionOverlay from './subcomponents/ShellConnectionOverlay';
import ShellEmptyState from './subcomponents/ShellEmptyState';
import ShellHeader from './subcomponents/ShellHeader';
import ShellMinimalView from './subcomponents/ShellMinimalView';
import TerminalShortcutsPanel from './subcomponents/TerminalShortcutsPanel';

// Shell prompt detection — a cursor line that matches this pattern means the
// CLI has returned to idle (bash/zsh/fish prompt, Claude >, Oh-My-Zsh themes, etc.).
// Covers: $ % # ❯ > › ❱ λ » → ⟩ and similar prompt-ending characters.
const SHELL_PROMPT_REGEX = /[\$%#❯>›❱λ»→⟩]\s*$/;
// Spinner characters — if visible on the cursor line the session is still running.
const SPINNER_REGEX = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

function looksLikeIdlePrompt(line: string): boolean {
  const stripped = line.trimEnd();
  // Very long lines are almost certainly code/output, not a prompt.
  // Raised to 200 to accommodate complex PS1 with git branch + path info.
  if (stripped.length > 200) return false;
  if (SPINNER_REGEX.test(stripped)) return false;
  return SHELL_PROMPT_REGEX.test(stripped);
}

type CliPromptOption = { number: string; label: string };

type ShellProps = {
  selectedProject?: Project | null;
  selectedSession?: ProjectSession | null;
  initialCommand?: string | null;
  isPlainShell?: boolean;
  onProcessComplete?: ((exitCode: number) => void) | null;
  minimal?: boolean;
  autoConnect?: boolean;
  isActive?: boolean;
  onSessionProcessing?: ((sessionId: string) => void) | null;
  onSessionNotProcessing?: ((sessionId: string) => void) | null;
};

export default function Shell({
  selectedProject = null,
  selectedSession = null,
  initialCommand = null,
  isPlainShell = false,
  onProcessComplete = null,
  minimal = false,
  autoConnect = false,
  isActive = true,
  onSessionProcessing = null,
  onSessionNotProcessing = null,
}: ShellProps) {
  const { t } = useTranslation('chat');
  const [isRestarting, setIsRestarting] = useState(false);
  const [cliPromptOptions, setCliPromptOptions] = useState<CliPromptOption[] | null>(null);
  const promptCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const isShellProcessingRef = useRef(false); // ref avoids stale-closure issues in async callbacks
  const onOutputRef = useRef<(() => void) | null>(null);

  const {
    terminalContainerRef,
    terminalRef,
    wsRef,
    isConnected,
    isInitialized,
    isConnecting,
    authUrl,
    authUrlVersion,
    connectToShell,
    disconnectFromShell,
    markUserDisconnected,
    openAuthUrlInBrowser,
    copyAuthUrlToClipboard,
  } = useShellRuntime({
    selectedProject,
    selectedSession,
    initialCommand,
    isPlainShell,
    minimal,
    autoConnect,
    isRestarting,
    onProcessComplete,
    onOutputRef,
  });

  // Check xterm.js buffer for CLI prompt patterns (❯ N. label)
  const checkBufferForPrompt = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const lastContentRow = buf.baseY + buf.cursorY;
    const scanEnd = Math.min(buf.baseY + buf.length - 1, lastContentRow + 10);
    const scanStart = Math.max(0, lastContentRow - PROMPT_BUFFER_SCAN_LINES);
    const lines: string[] = [];
    for (let i = scanStart; i <= scanEnd; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString().trimEnd());
    }

    let footerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/esc to cancel/i.test(lines[i]) || /enter to select/i.test(lines[i])) {
        footerIdx = i;
        break;
      }
    }

    if (footerIdx === -1) {
      setCliPromptOptions(null);
      return;
    }

    // Scan upward from footer collecting numbered options.
    // Non-matching lines are allowed (multi-line labels, blank separators)
    // because CLI prompts may wrap options across multiple terminal rows.
    const optMap = new Map<string, string>();
    const optScanStart = Math.max(0, footerIdx - PROMPT_OPTION_SCAN_LINES);
    for (let i = footerIdx - 1; i >= optScanStart; i--) {
      const match = lines[i].match(/^\s*[❯›>]?\s*(\d+)\.\s+(.+)/);
      if (match) {
        const num = match[1];
        const label = match[2].trim();
        if (parseInt(num, 10) <= PROMPT_MAX_OPTIONS && label.length > 0 && !optMap.has(num)) {
          optMap.set(num, label);
        }
      }
    }

    const valid: CliPromptOption[] = [];
    for (let i = 1; i <= optMap.size; i++) {
      if (optMap.has(String(i))) valid.push({ number: String(i), label: optMap.get(String(i))! });
      else break;
    }

    setCliPromptOptions(valid.length >= PROMPT_MIN_OPTIONS ? valid : null);
  }, [terminalRef]);

  // Schedule prompt check after terminal output (debounced)
  const schedulePromptCheck = useCallback(() => {
    if (promptCheckTimer.current) clearTimeout(promptCheckTimer.current);
    promptCheckTimer.current = setTimeout(checkBufferForPrompt, PROMPT_DEBOUNCE_MS);
  }, [checkBufferForPrompt]);

  // Check cursor line for shell prompt → mark session as no longer processing.
  //
  // retryCount   — how many times we retried because the prompt was NOT visible yet.
  // confirmCount — how many consecutive checks have BOTH seen a prompt AND a stable cursor.
  //
  // Two guards against false idle detection:
  //   1. looksLikeIdlePrompt: cursor line must end with a prompt character.
  //   2. Cursor stability: cursor X/Y must not have moved since the previous check.
  //      A running command continuously scrolls/moves the cursor; an idle shell prompt
  //      sits motionless. If the cursor moved → reset confirmCount and retry.
  //
  // We require SHELL_IDLE_CONFIRM_REQUIRED consecutive confirmations (prompt + stable)
  // before emitting "not processing". Any new terminal output cancels the pending
  // confirmation via scheduleIdleCheck, which clears the timer and resets lastCursorRef.
  const checkIfIdle = useCallback((retryCount = 0, confirmCount = 0) => {
    if (!isShellProcessingRef.current) return;
    const term = terminalRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const curX = buf.cursorX;
    const curY = buf.baseY + buf.cursorY;
    const prev = lastCursorRef.current;
    const isCursorStable = prev !== null && prev.x === curX && prev.y === curY;
    lastCursorRef.current = { x: curX, y: curY };

    const cursorLine = buf.getLine(curY)?.translateToString().trimEnd() ?? '';

    if (looksLikeIdlePrompt(cursorLine) && isCursorStable) {
      const nextConfirm = confirmCount + 1;
      if (nextConfirm >= SHELL_IDLE_CONFIRM_REQUIRED && selectedSession?.id) {
        // All confirmations passed — the shell is genuinely idle.
        isShellProcessingRef.current = false;
        onSessionNotProcessing?.(selectedSession.id);
        return;
      }
      // Need more confirmations — schedule next check soon.
      // New output will cancel this via scheduleIdleCheck → no flicker.
      idleCheckTimerRef.current = setTimeout(
        () => checkIfIdle(retryCount, nextConfirm),
        SHELL_IDLE_CONFIRM_MS,
      );
      return;
    }

    // Prompt not yet visible, or cursor moved (command still running) —
    // reset confirmCount and retry if within limit.
    if (retryCount < SHELL_IDLE_MAX_RETRIES) {
      idleCheckTimerRef.current = setTimeout(
        () => checkIfIdle(retryCount + 1, 0),
        SHELL_IDLE_RETRY_MS,
      );
    }
  }, [terminalRef, selectedSession?.id, onSessionNotProcessing]);

  const scheduleIdleCheck = useCallback(() => {
    if (idleCheckTimerRef.current) clearTimeout(idleCheckTimerRef.current);
    lastCursorRef.current = null; // reset cursor baseline for this debounce cycle
    idleCheckTimerRef.current = setTimeout(checkIfIdle, SHELL_IDLE_DETECT_MS);
  }, [checkIfIdle]);

  // Combined output handler: marks as processing + schedules both checks.
  const handleOutput = useCallback(() => {
    if (!isShellProcessingRef.current && isConnected && selectedSession?.id) {
      isShellProcessingRef.current = true;
      onSessionProcessing?.(selectedSession.id);
    }
    schedulePromptCheck();
    scheduleIdleCheck();
  }, [isConnected, selectedSession?.id, onSessionProcessing, schedulePromptCheck, scheduleIdleCheck]);

  // Wire up the combined output callback
  useEffect(() => {
    onOutputRef.current = handleOutput;
  }, [handleOutput]);

  // Cleanup both timers on unmount
  useEffect(() => {
    return () => {
      if (promptCheckTimer.current) clearTimeout(promptCheckTimer.current);
      if (idleCheckTimerRef.current) clearTimeout(idleCheckTimerRef.current);
    };
  }, []);

  // Clear stale prompt options, cancel timers, and reset processing state on disconnect
  useEffect(() => {
    if (!isConnected) {
      if (promptCheckTimer.current) {
        clearTimeout(promptCheckTimer.current);
        promptCheckTimer.current = null;
      }
      if (idleCheckTimerRef.current) {
        clearTimeout(idleCheckTimerRef.current);
        idleCheckTimerRef.current = null;
      }
      setCliPromptOptions(null);
      if (isShellProcessingRef.current && selectedSession?.id) {
        isShellProcessingRef.current = false;
        onSessionNotProcessing?.(selectedSession.id);
      }
    }
  }, [isConnected, selectedSession?.id, onSessionNotProcessing]);

  useEffect(() => {
    if (!isActive || !isInitialized || !isConnected) {
      return;
    }

    const focusTerminal = () => {
      terminalRef.current?.focus();
    };

    const animationFrameId = window.requestAnimationFrame(focusTerminal);
    const timeoutId = window.setTimeout(focusTerminal, 0);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.clearTimeout(timeoutId);
    };
  }, [isActive, isConnected, isInitialized, terminalRef]);

  const sendInput = useCallback(
    (data: string) => {
      sendSocketMessage(wsRef.current, { type: 'input', data });
    },
    [wsRef],
  );

  const sessionDisplayName = useMemo(() => getSessionDisplayName(selectedSession), [selectedSession]);
  const sessionDisplayNameShort = useMemo(
    () => (sessionDisplayName ? sessionDisplayName.slice(0, 30) : null),
    [sessionDisplayName],
  );
  const sessionDisplayNameLong = useMemo(
    () => (sessionDisplayName ? sessionDisplayName.slice(0, 50) : null),
    [sessionDisplayName],
  );

  const handleRestartShell = useCallback(() => {
    setIsRestarting(true);
    window.setTimeout(() => {
      setIsRestarting(false);
    }, SHELL_RESTART_DELAY_MS);
  }, []);

  // Debug: log whenever the connecting/loading overlay becomes visible so we
  // can trace *why* it appeared (network drop, first connect, restart, etc.)
  const prevOverlayModeRef = useRef<string | null>(null);
  useEffect(() => {
    const mode = !isInitialized ? 'loading' : isConnecting ? 'connecting' : !isConnected ? 'connect' : null;
    if (mode !== null && mode !== prevOverlayModeRef.current) {
      console.log('[Shell] overlay appeared:', {
        mode,
        projectPath: selectedProject?.path ?? null,
        sessionId: selectedSession?.id ?? null,
        isInitialized,
        isConnecting,
        isConnected,
        autoConnect,
        isActive,
        isRestarting,
      });
    }
    prevOverlayModeRef.current = mode;
  }, [isInitialized, isConnecting, isConnected, selectedProject?.path, selectedSession?.id, autoConnect, isActive, isRestarting]);

  if (!selectedProject) {
    return (
      <ShellEmptyState
        title={t('shell.selectProject.title')}
        description={t('shell.selectProject.description')}
      />
    );
  }

  if (minimal) {
    return (
      <>
        <ShellMinimalView
          terminalContainerRef={terminalContainerRef}
          authUrl={authUrl}
          authUrlVersion={authUrlVersion}
          initialCommand={initialCommand}
          isConnected={isConnected}
          openAuthUrlInBrowser={openAuthUrlInBrowser}
          copyAuthUrlToClipboard={copyAuthUrlToClipboard}
        />
        <TerminalShortcutsPanel
          wsRef={wsRef}
          terminalRef={terminalRef}
          isConnected={isConnected}
          bottomOffset="bottom-0"
        />
      </>
    );
  }

  const readyDescription = isPlainShell
    ? t('shell.runCommand', {
        command: initialCommand || t('shell.defaultCommand'),
        projectName: selectedProject.displayName,
      })
    : selectedSession
      ? t('shell.resumeSession', { displayName: sessionDisplayNameLong })
      : t('shell.startSession');

  const connectingDescription = isPlainShell
    ? t('shell.runCommand', {
        command: initialCommand || t('shell.defaultCommand'),
        projectName: selectedProject.displayName,
      })
    : t('shell.startCli', { projectName: selectedProject.displayName });

  const provider = isPlainShell
    ? null
    : (selectedSession?.__provider ?? (localStorage.getItem('selected-provider') || 'claude'));

  const sessionId = isPlainShell ? null : (selectedSession?.id ?? null);
  const shortSessionId = sessionId ? sessionId.slice(0, 8) : null;

  const commandArgs = isPlainShell
    ? (initialCommand || null)
    : (() => {
        switch (provider) {
          case 'claude':
            return shortSessionId ? `claude --resume ${shortSessionId}...` : 'claude';
          case 'gemini':
            return shortSessionId ? `gemini --resume ${shortSessionId}...` : 'gemini';
          case 'cursor':
            return shortSessionId ? `cursor-agent --resume=${shortSessionId}...` : 'cursor-agent';
          case 'codex':
            return shortSessionId ? `codex resume ${shortSessionId}...` : 'codex';
          case 'copilot':
            return shortSessionId ? `copilot --resume ${shortSessionId}...` : 'copilot';
          default:
            return null;
        }
      })();

  const overlayMode = !isInitialized ? 'loading' : isConnecting ? 'connecting' : !isConnected ? 'connect' : null;
  const overlayDescription = overlayMode === 'connecting' ? connectingDescription : readyDescription;

  return (
    <div className="flex h-full w-full flex-col bg-gray-900">
      <ShellHeader
        isConnected={isConnected}
        isInitialized={isInitialized}
        isRestarting={isRestarting}
        hasSession={Boolean(selectedSession)}
        sessionDisplayNameShort={sessionDisplayNameShort}
        onDisconnect={() => { markUserDisconnected(); disconnectFromShell(); }}
        onRestart={handleRestartShell}
        statusNewSessionText={t('shell.status.newSession')}
        statusInitializingText={t('shell.status.initializing')}
        statusRestartingText={t('shell.status.restarting')}
        disconnectLabel={t('shell.actions.disconnect')}
        disconnectTitle={t('shell.actions.disconnectTitle')}
        restartLabel={t('shell.actions.restart')}
        restartTitle={t('shell.actions.restartTitle')}
        disableRestart={isRestarting}
      />

      <div className="relative flex-1 overflow-hidden p-2">
        <div
          ref={terminalContainerRef}
          className="h-full w-full focus:outline-none"
          style={{ outline: 'none' }}
        />

        {overlayMode && (
          <ShellConnectionOverlay
            mode={overlayMode}
            description={overlayDescription}
            loadingLabel={t('shell.loading')}
            connectLabel={t('shell.actions.connect')}
            connectTitle={t('shell.actions.connectTitle')}
            connectingLabel={t('shell.connecting')}
            commandArgs={commandArgs ?? undefined}
            onConnect={connectToShell}
          />
        )}

        {cliPromptOptions && isConnected && (
          <div
            className="absolute inset-x-0 bottom-0 z-10 border-t border-gray-700/80 bg-gray-800/95 px-3 py-2 backdrop-blur-sm"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="flex flex-wrap items-center gap-2">
              {cliPromptOptions.map((opt) => (
                <button
                  type="button"
                  key={opt.number}
                  onClick={() => {
                    sendInput(opt.number);
                    setCliPromptOptions(null);
                  }}
                  className="max-w-36 truncate rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                  title={`${opt.number}. ${opt.label}`}
                >
                  {opt.number}. {opt.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  sendInput('\x1b');
                  setCliPromptOptions(null);
                }}
                className="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:bg-gray-600"
              >
                Esc
              </button>
            </div>
          </div>
        )}
      </div>

      <TerminalShortcutsPanel
        wsRef={wsRef}
        terminalRef={terminalRef}
        isConnected={isConnected}
      />

    </div>
  );
}
