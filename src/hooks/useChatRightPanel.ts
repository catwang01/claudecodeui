import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodeEditorFile, CodeEditorDiffInfo } from '../components/code-editor/types/types';

export type RightPanelTab = 'files' | 'git' | 'editor';

export interface RightPanelState {
  open: boolean;
  activeTab: RightPanelTab;
  width: number;
  editingFile: CodeEditorFile | null;
  editorExpanded: boolean;
}

const STORAGE_KEY = 'rightPanel.state';

const DEFAULTS: RightPanelState = {
  open: false,
  activeTab: 'files',
  width: 360,
  editingFile: null,
  editorExpanded: false,
};

function readInitialState(): RightPanelState {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<RightPanelState>;
    return {
      open: typeof parsed.open === 'boolean' ? parsed.open : DEFAULTS.open,
      // 'editor' is never persisted — guard against stale localStorage value
      activeTab: parsed.activeTab === 'git' ? 'git' : 'files',
      width:
        typeof parsed.width === 'number'
          ? Math.max(200, Math.min(800, parsed.width))
          : DEFAULTS.width,
      editingFile: null,
      editorExpanded: false,
    };
  } catch {
    return DEFAULTS;
  }
}

export function useChatRightPanel() {
  const [state, setState] = useState<RightPanelState>(readInitialState);
  // Snapshot of panel state before openFile() — restored by closeFile()
  const preFileOpenSnapshotRef = useRef<{ open: boolean; activeTab: 'files' | 'git' } | null>(null);

  // Persist only open/activeTab/width — never editingFile or editorExpanded
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        open: state.open,
        activeTab: state.activeTab === 'editor' ? 'files' : state.activeTab,
        width: state.width,
      }),
    );
  }, [state]);

  // Toggle files/git panel (same-tab click closes the panel)
  const toggle = useCallback((tab: 'files' | 'git') => {
    setState((prev) => {
      if (!prev.open) return { ...prev, open: true, activeTab: tab };
      if (prev.activeTab === tab) return { ...prev, open: false };
      return { ...prev, activeTab: tab };
    });
  }, []);

  // Switch active tab without toggle-close (used by tab buttons inside the panel)
  const setActiveTab = useCallback((tab: RightPanelTab) => {
    setState((prev) => ({ ...prev, activeTab: tab }));
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

  const adjustWidth = useCallback((delta: number) => {
    setState((prev) => ({
      ...prev,
      width: Math.max(200, Math.min(800, prev.width - delta)),
    }));
  }, []);

  const openFile = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null, projectName?: string) => {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const fileName = normalizedPath.split('/').pop() || filePath;
      const file: CodeEditorFile = { name: fileName, path: filePath, projectName, diffInfo };
      setState((prev) => {
        // Save snapshot only when not already on the editor tab
        if (prev.activeTab !== 'editor') {
          preFileOpenSnapshotRef.current = {
            open: prev.open,
            activeTab: prev.activeTab === 'git' ? 'git' : 'files',
          };
        }
        return { ...prev, open: true, activeTab: 'editor', editingFile: file, editorExpanded: false };
      });
    },
    [],
  );

  const closeFile = useCallback(() => {
    const snapshot = preFileOpenSnapshotRef.current;
    preFileOpenSnapshotRef.current = null;
    setState((prev) => {
      if (!snapshot || !snapshot.open) {
        // Panel was closed before the file was opened → close it entirely
        return { ...prev, open: false, activeTab: 'files', editingFile: null, editorExpanded: false };
      }
      // Panel was already open on another tab → restore that tab
      return { ...prev, open: true, activeTab: snapshot.activeTab, editingFile: null, editorExpanded: false };
    });
  }, []);

  const toggleEditorExpand = useCallback(() => {
    setState((prev) => ({ ...prev, editorExpanded: !prev.editorExpanded }));
  }, []);

  return { state, toggle, setActiveTab, close, setWidth, adjustWidth, openFile, closeFile, toggleEditorExpand };
}
