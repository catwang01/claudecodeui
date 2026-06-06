import { useCallback, useEffect, useState } from 'react';

export type RightPanelTab = 'files' | 'git';

export interface RightPanelState {
  open: boolean;
  activeTab: RightPanelTab;
  width: number;
}

const STORAGE_KEY = 'rightPanel.state';

const DEFAULTS: RightPanelState = {
  open: false,
  activeTab: 'files',
  width: 360,
};

function readInitialState(): RightPanelState {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<RightPanelState>;
    return {
      open: typeof parsed.open === 'boolean' ? parsed.open : DEFAULTS.open,
      activeTab: parsed.activeTab === 'git' ? 'git' : 'files',
      width:
        typeof parsed.width === 'number'
          ? Math.max(200, Math.min(800, parsed.width))
          : DEFAULTS.width,
    };
  } catch {
    return DEFAULTS;
  }
}

export function useChatRightPanel() {
  const [state, setState] = useState<RightPanelState>(readInitialState);

  // Persist on every change
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const toggle = useCallback((tab: RightPanelTab) => {
    setState((prev) => {
      if (!prev.open) return { ...prev, open: true, activeTab: tab };
      if (prev.activeTab === tab) return { ...prev, open: false };
      return { ...prev, activeTab: tab };
    });
  }, []);

  const close = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const setWidth = useCallback((width: number) => {
    setState((prev) => ({
      ...prev,
      width: Math.max(200, Math.min(800, width)),
    }));
  }, []);

  return { state, toggle, close, setWidth };
}
