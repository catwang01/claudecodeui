# Merge Code Preview into Right Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `EditorSidebar` as a separate third column and merge file preview into the right panel as an `'editor'` tab, with expand-to-full-width only available on that tab.

**Architecture:** Add `'editor'` to `RightPanelTab`; lift `editingFile` / `editorExpanded` state into `useChatRightPanel`; add `openFile` / `closeFile` / `toggleEditorExpand` / `setActiveTab` methods; update `RightPanel` with a third tab that renders `FileViewer`; update `MainContent` to wire everything up and remove `useEditorSidebar`; delete the two old files.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, lucide-react

---

## File Map

| File | Change |
|------|--------|
| `src/hooks/useChatRightPanel.ts` | Add `'editor'` to type, add file state + 4 new methods |
| `src/components/right-panel/RightPanel.tsx` | Add editor tab with FileViewer, expand button |
| `src/components/main-content/view/MainContent.tsx` | Remove useEditorSidebar, wire openFile, update layout |
| `src/components/code-editor/view/EditorSidebar.tsx` | **Delete** |
| `src/components/code-editor/hooks/useEditorSidebar.ts` | **Delete** |

---

### Task 1: Extend `useChatRightPanel.ts`

**Files:**
- Modify: `src/hooks/useChatRightPanel.ts`

- [ ] **Step 1: Replace the entire file with the new version**

```ts
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
```

- [ ] **Step 2: Verify TypeScript errors appear in the expected places**

Run: `cd /Users/edward/MyFolder/claudecodeui && npx tsc --noEmit 2>&1 | head -40`

Expected: errors in `RightPanel.tsx` (missing new props) and `MainContent.tsx` (old `toggle` call signature / missing `openFile`). No errors expected in `useChatRightPanel.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useChatRightPanel.ts
git commit -m "refactor: add editor tab state and openFile/closeFile methods to useChatRightPanel"
```

---

### Task 2: Update `RightPanel.tsx` with the editor tab

**Files:**
- Modify: `src/components/right-panel/RightPanel.tsx`

- [ ] **Step 1: Replace the entire file**

```tsx
import { FileCode, Maximize2, Minimize2, X } from 'lucide-react';
import FileTree from '../file-tree/view/FileTree';
import GitPanel from '../git-panel/view/GitPanel';
import FileViewer from '../code-editor/view/FileViewer';
import type { RightPanelTab } from '../../hooks/useChatRightPanel';
import type { CodeEditorFile } from '../code-editor/types/types';
import type { Project } from '../../types/app';

interface RightPanelProps {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  onClose: () => void;
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  editingFile: CodeEditorFile | null;
  editorExpanded: boolean;
  onCloseFile: () => void;
  onToggleEditorExpand: () => void;
  isMobile: boolean;
  projectPath?: string;
}

export default function RightPanel({
  activeTab,
  onTabChange,
  onClose,
  selectedProject,
  onFileOpen,
  editingFile,
  editorExpanded,
  onCloseFile,
  onToggleEditorExpand,
  isMobile,
  projectPath,
}: RightPanelProps) {
  // Mobile: show FileViewer as full-screen overlay when editor tab is active
  if (isMobile && activeTab === 'editor' && editingFile) {
    return (
      <FileViewer
        key={editingFile.path}
        file={editingFile}
        onClose={onCloseFile}
        projectPath={projectPath}
        isSidebar={false}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border/60 bg-background">
      {/* Panel header */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <div role="tablist" className="flex items-center">
          <button
            role="tab"
            aria-selected={activeTab === 'git'}
            onClick={() => onTabChange('git')}
            className={`rounded px-2.5 py-1 text-sm font-medium transition-colors ${
              activeTab === 'git'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Git
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'files'}
            onClick={() => onTabChange('files')}
            className={`rounded px-2.5 py-1 text-sm font-medium transition-colors ${
              activeTab === 'files'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Files
          </button>
          {editingFile && (
            <button
              role="tab"
              aria-selected={activeTab === 'editor'}
              onClick={() => onTabChange('editor')}
              className={`flex items-center gap-1 rounded px-2.5 py-1 text-sm font-medium transition-colors ${
                activeTab === 'editor'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <FileCode className="h-3.5 w-3.5" />
              <span className="max-w-[120px] truncate">{editingFile.name}</span>
            </button>
          )}
        </div>

        <div className="flex-1" />

        {activeTab === 'editor' && editingFile && (
          <button
            aria-label={editorExpanded ? 'Collapse editor' : 'Expand editor'}
            onClick={onToggleEditorExpand}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {editorExpanded ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
        )}

        <button
          aria-label="Close panel"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Panel content */}
      <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'files' && (
          <FileTree selectedProject={selectedProject} onFileOpen={onFileOpen} />
        )}
        {activeTab === 'git' && (
          <GitPanel selectedProject={selectedProject} onFileOpen={onFileOpen} />
        )}
        {activeTab === 'editor' && editingFile && (
          <FileViewer
            key={editingFile.path}
            file={editingFile}
            onClose={onCloseFile}
            projectPath={projectPath}
            isSidebar
            isExpanded={editorExpanded}
            onToggleExpand={onToggleEditorExpand}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify no TS errors in this file**

Run: `npx tsc --noEmit 2>&1 | grep "right-panel/RightPanel"`

Expected: no output (this file is clean; `MainContent.tsx` will still have errors — that's fine).

- [ ] **Step 3: Commit**

```bash
git add src/components/right-panel/RightPanel.tsx
git commit -m "feat: add editor tab to RightPanel with FileViewer and expand button"
```

---

### Task 3: Update `MainContent.tsx`

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`

- [ ] **Step 1: Replace the entire file**

```tsx
import React, { useCallback, useEffect } from 'react';
import ChatInterface from '../../chat/view/ChatInterface';
import ShellSessionPool from '../../shell-pool/ShellSessionPool';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import type { Project } from '../../../types/app';
import type { CodeEditorDiffInfo } from '../../code-editor/types/types';
import { TaskMasterPanel } from '../../task-master';
import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import { useChatRightPanel } from '../../../hooks/useChatRightPanel';
import RightPanel from '../../right-panel/RightPanel';
import ResizeHandle from '../../right-panel/ResizeHandle';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  allProjects = [],
  newSessionToken,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, showSubAgentInput, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  const {
    state: rightPanelState,
    toggle: toggleRightPanel,
    setActiveTab: setRightPanelTab,
    close: closeRightPanel,
    setWidth: setRightPanelWidth,
    adjustWidth: adjustRightPanelWidth,
    openFile: openRightPanelFile,
    closeFile: closeRightPanelFile,
    toggleEditorExpand: toggleRightPanelEditorExpand,
  } = useChatRightPanel();

  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
      openRightPanelFile(filePath, diffInfo, selectedProject?.name);
    },
    [openRightPanelFile, selectedProject?.name],
  );

  const handleRightPanelResize = useCallback(
    (delta: number) => adjustRightPanelWidth(delta),
    [adjustRightPanelWidth],
  );

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  const { editorExpanded } = rightPanelState;

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onToggleFiles={() => toggleRightPanel('files')}
        onToggleGit={() => toggleRightPanel('git')}
        rightPanelOpen={rightPanelState.open}
        rightPanelActiveTab={rightPanelState.activeTab}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''}`}
          style={
            rightPanelState.open && !editorExpanded
              ? { width: `calc(100% - ${rightPanelState.width + 6}px)`, flex: 'none' }
              : { flex: '1' }
          }
        >
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                latestMessage={latestMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionActive={onSessionActive}
                onSessionInactive={onSessionInactive}
                onSessionProcessing={onSessionProcessing}
                onSessionNotProcessing={onSessionNotProcessing}
                processingSessions={processingSessions}
                onReplaceTemporarySession={onReplaceTemporarySession}
                onNavigateToSession={onNavigateToSession}
                onShowSettings={onShowSettings}
                allProjects={allProjects}
                newSessionToken={newSessionToken}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                showSubAgentInput={showSubAgentInput}
                autoScrollToBottom={autoScrollToBottom}
                sendByCtrlEnter={sendByCtrlEnter}
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              />
            </ErrorBoundary>
          </div>

          <div className={`h-full w-full overflow-hidden ${activeTab === 'shell' ? 'block' : 'hidden'}`}>
            <ShellSessionPool
              project={selectedProject}
              activeSession={selectedSession}
              isActive={activeTab === 'shell'}
            />
          </div>

          {shouldShowTasksTab && <TaskMasterPanel isVisible={activeTab === 'tasks'} />}

          <div className={`h-full overflow-hidden ${activeTab === 'preview' ? 'block' : 'hidden'}`} />

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        {/* Right panel (Git / Files / Editor) */}
        {rightPanelState.open && (
          <>
            {!editorExpanded && (
              <ResizeHandle onResize={handleRightPanelResize} />
            )}
            <div
              style={editorExpanded ? undefined : { width: rightPanelState.width, flexShrink: 0 }}
              className={`flex min-h-0 flex-col overflow-hidden ${editorExpanded ? 'flex-1' : ''}`}
            >
              <RightPanel
                activeTab={rightPanelState.activeTab}
                onTabChange={setRightPanelTab}
                onClose={closeRightPanel}
                selectedProject={selectedProject}
                onFileOpen={handleFileOpen}
                editingFile={rightPanelState.editingFile}
                editorExpanded={editorExpanded}
                onCloseFile={closeRightPanelFile}
                onToggleEditorExpand={toggleRightPanelEditorExpand}
                isMobile={isMobile}
                projectPath={selectedProject.path}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
```

- [ ] **Step 2: Verify zero TypeScript errors in the whole project**

Run: `npx tsc --noEmit 2>&1`

Expected: errors only pointing to `EditorSidebar.tsx` and `useEditorSidebar.ts` (about to be deleted) — or zero errors if nothing else references them.

- [ ] **Step 3: Commit**

```bash
git add src/components/main-content/view/MainContent.tsx
git commit -m "refactor: wire openFile/closeFile into MainContent, remove EditorSidebar"
```

---

### Task 4: Delete the old EditorSidebar files

**Files:**
- Delete: `src/components/code-editor/view/EditorSidebar.tsx`
- Delete: `src/components/code-editor/hooks/useEditorSidebar.ts`

- [ ] **Step 1: Delete both files**

```bash
rm /Users/edward/MyFolder/claudecodeui/src/components/code-editor/view/EditorSidebar.tsx
rm /Users/edward/MyFolder/claudecodeui/src/components/code-editor/hooks/useEditorSidebar.ts
```

- [ ] **Step 2: Verify zero TypeScript errors**

Run: `cd /Users/edward/MyFolder/claudecodeui && npx tsc --noEmit 2>&1`

Expected: **no output** (zero errors).

- [ ] **Step 3: Commit**

```bash
git add -A src/components/code-editor/
git commit -m "chore: delete EditorSidebar and useEditorSidebar (merged into right panel)"
```

---

### Task 5: Test run + smoke check

**Files:** none

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/edward/MyFolder/claudecodeui && npm test -- --run 2>&1 | tail -15`

Expected: all tests pass (no new failures vs baseline of 124 tests).

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit 2>&1`

Expected: no output.

- [ ] **Step 3: Mental smoke check**

Verify the logic covers these cases:

1. **File click when panel is closed**: `openFile()` opens panel → Editor tab. `closeFile()` closes panel entirely.
2. **File click when Files tab is open**: `openFile()` saves snapshot `{open:true, activeTab:'files'}` → switches to Editor tab. `closeFile()` restores Files tab.
3. **File click when Git tab is open**: same as above but restores Git tab.
4. **Clicking another file while Editor tab is open**: `openFile()` sees `activeTab === 'editor'`, does NOT overwrite snapshot → just updates `editingFile`.
5. **Expand button**: only visible when `activeTab === 'editor'` and `editingFile` is set. Hides left column, right panel goes `flex-1`.
6. **📁/🔀 toggle buttons**: still call `toggle('files')` / `toggle('git')`, unaffected by editor state.
7. **Mobile**: when `isMobile && activeTab === 'editor'`, `RightPanel` renders full-screen `FileViewer` overlay instead of the panel layout.

- [ ] **Step 4: Verify localStorage behavior**

Open browser DevTools → Application → localStorage. Check `rightPanel.state`. After opening a file, the persisted `activeTab` should be `'files'` (not `'editor'`). After a page reload, no stale editor file is shown.
