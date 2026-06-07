import type { ITerminalOptions } from '@xterm/xterm';

export const CODEX_DEVICE_AUTH_URL = 'https://auth.openai.com/codex/device';
export const SHELL_IDLE_DETECT_MS = 10000;  // wait 10 s of silence before first idle check
export const SHELL_IDLE_RETRY_MS = 2000;    // interval between retries when prompt not yet visible
export const SHELL_IDLE_MAX_RETRIES = 3;    // give up after 3 retries (~6 s extra)
export const SHELL_IDLE_CONFIRM_MS = 2000;  // interval between consecutive confirmations
export const SHELL_IDLE_CONFIRM_REQUIRED = 2; // consecutive stable idle checks needed
export const SHELL_PING_INTERVAL_MS = 25000; // keepalive ping to prevent background WebSocket timeout
export const SHELL_RESTART_DELAY_MS = 200;
export const TERMINAL_INIT_DELAY_MS = 100;
export const TERMINAL_RESIZE_DELAY_MS = 50;

// CLI prompt overlay detection
export const PROMPT_DEBOUNCE_MS = 500;
export const PROMPT_BUFFER_SCAN_LINES = 20;
export const PROMPT_OPTION_SCAN_LINES = 15;
export const PROMPT_MAX_OPTIONS = 5;
export const PROMPT_MIN_OPTIONS = 2;

export const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  allowProposedApi: true,
  allowTransparency: false,
  convertEol: true,
  scrollback: 10000,
  tabStopWidth: 4,
  windowsMode: false,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  // Keep the runtime theme keys used by the previous JSX implementation.
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#ffffff',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff',
    extendedAnsi: [
      '#000000',
      '#800000',
      '#008000',
      '#808000',
      '#000080',
      '#800080',
      '#008080',
      '#c0c0c0',
      '#808080',
      '#ff0000',
      '#00ff00',
      '#ffff00',
      '#0000ff',
      '#ff00ff',
      '#00ffff',
      '#ffffff',
    ],
  },
};
