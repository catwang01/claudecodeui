/**
 * Configurable logger. Enable via browser console:
 *   window.__DEBUG__ = true
 * Disable:
 *   window.__DEBUG__ = false
 */

declare global {
  interface Window {
    __DEBUG__: boolean;
  }
}

const isEnabled = () => typeof window !== 'undefined' && window.__DEBUG__ === true;

export const logger = {
  log: (...args: unknown[]) => {
    if (isEnabled()) console.log(...args);
  },
  error: (...args: unknown[]) => {
    if (isEnabled()) console.error(...args);
  },
  warn: (...args: unknown[]) => {
    if (isEnabled()) console.warn(...args);
  },
  debug: (...args: unknown[]) => {
    if (isEnabled()) console.debug(...args);
  },
  group: (...args: unknown[]) => {
    if (isEnabled()) console.group(...args);
  },
  groupEnd: () => {
    if (isEnabled()) console.groupEnd();
  },
};
