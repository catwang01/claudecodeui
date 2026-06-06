# Chat Right Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable, resizable right panel to the chat view that renders the existing `FileTree` or `GitPanel` components, letting users browse files and git status without switching tabs.

**Architecture:** A new `useChatRightPanel` hook owns all panel state (open/tab/width) and persists it to `localStorage`. `MainContent.tsx` calls the hook and conditionally renders `<ResizeHandle>` + `<RightPanel>` alongside the existing chat column in the existing `flex min-h-0 flex-1` container. Toggle buttons (📁 / 🔀) are added to `MainContentHeader` (chat-tab only).

**Tech Stack:** React 18, TypeScript, Tailwind CSS, lucide-react icons, Vitest + @testing-library/react

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/hooks/useChatRightPanel.ts` | **Create** | State hook: open/tab/width, localStorage persistence, toggle/close/resize logic |
| `src/components/right-panel/ResizeHandle.tsx` | **Create** | 6px drag strip; owns document mousemove/mouseup listeners, calls `onResize(delta)` |
| `src/components/right-panel/RightPanel.tsx` | **Create** | Tab header (Files/Git + close button) + renders FileTree or GitPanel |
| `src/hooks/__tests__/useChatRightPanel.test.ts` | **Create** | Unit tests for hook |
| `src/components/right-panel/__tests__/ResizeHandle.test.tsx` | **Create** | Unit tests for drag behaviour |
| `src/components/right-panel/__tests__/RightPanel.test.tsx` | **Create** | Unit tests for tab switching + close |
| `src/components/main-content/view/MainContent.tsx` | **Modify** | Mount hook + conditionally render ResizeHandle + RightPanel |
| `src/components/main-content/types/types.ts` | **Modify** | Add `onToggleFiles`, `onToggleGit`, `rightPanelOpen`, `rightPanelActiveTab` to `MainContentHeaderProps` |
| `src/components/main-content/view/subcomponents/MainContentHeader.tsx` | **Modify** | Add 📁/🔀 toggle buttons (chat-tab only) |

---

## Task 1: `useChatRightPanel` hook

**Files:**
- Create: `src/hooks/useChatRightPanel.ts`
- Create: `src/hooks/__tests__/useChatRightPanel.test.ts`

### Step 1 — Write the failing tests

Create `src/hooks/__tests__/useChatRightPanel.test.ts`:

```ts
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatRightPanel } from '../useChatRightPanel';

beforeEach(() => {
  localStorage.clear();
});

describe('useChatRightPanel', () => {
  it('starts closed with defaults', () => {
    const { result } = renderHook(() => useChatRightPanel());
    expect(result.current.state).toEqual({
      open: false,
      activeTab: 'files',
      width: 360,
    });
  });

  it('toggle("files") opens panel on files tab', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('files'));
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.activeTab).toBe('files');
  });

  it('toggle("files") while open on files closes panel', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('files'));
    act(() => result.current.toggle('files'));
    expect(result.current.state.open).toBe(false);
  });

  it('toggle("git") while open on files switches tab (does not close)', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('files'));
    act(() => result.current.toggle('git'));
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.activeTab).toBe('git');
  });

  it('close() sets open to false', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('git'));
    act(() => result.current.close());
    expect(result.current.state.open).toBe(false);
  });

  it('setWidth clamps to [200, 800]', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.setWidth(50));
    expect(result.current.state.width).toBe(200);
    act(() => result.current.setWidth(1200));
    expect(result.current.state.width).toBe(800);
    act(() => result.current.setWidth(500));
    expect(result.current.state.width).toBe(500);
  });

  it('persists state to localStorage key "rightPanel.state"', () => {
    const { result } = renderHook(() => useChatRightPanel());
    act(() => result.current.toggle('git'));
    const stored = JSON.parse(localStorage.getItem('rightPanel.state') ?? '{}');
    expect(stored.open).toBe(true);
    expect(stored.activeTab).toBe('git');
  });

  it('reads initial state from localStorage', () => {
    localStorage.setItem(
      'rightPanel.state',
      JSON.stringify({ open: true, activeTab: 'git', width: 450 }),
    );
    const { result } = renderHook(() => useChatRightPanel());
    expect(result.current.state).toEqual({ open: true, activeTab: 'git', width: 450 });
  });
});
```

- [ ] **Step 2: Run to confirm all tests fail**

```bash
cd /Users/edward/MyFolder/claudecodeui && npx vitest run src/hooks/__tests__/useChatRightPanel.test.ts 2>&1 | tail -20
```

Expected: error `Cannot find module '../useChatRightPanel'`.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useChatRightPanel.ts`:

```ts
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
```

- [ ] **Step 4: Run tests — expect all 8 to pass**

```bash
cd /Users/edward/MyFolder/claudecodeui && npx vitest run src/hooks/__tests__/useChatRightPanel.test.ts 2>&1 | tail -20
```

Expected: `Test Files 1 passed (1)`, `Tests 8 passed (8)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/edward/MyFolder/claudecodeui
git add src/hooks/useChatRightPanel.ts src/hooks/__tests__/useChatRightPanel.test.ts
git commit -m "feat: add useChatRightPanel hook with localStorage persistence"
```

---

## Task 2: `ResizeHandle` component

**Files:**
- Create: `src/components/right-panel/ResizeHandle.tsx`
- Create: `src/components/right-panel/__tests__/ResizeHandle.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/components/right-panel/__tests__/ResizeHandle.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ResizeHandle from '../ResizeHandle';

describe('ResizeHandle', () => {
  it('renders a visible drag strip', () => {
    render(<ResizeHandle onResize={vi.fn()} />);
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('calls onResize with positive delta when mouse moves right', () => {
    const onResize = vi.fn();
    render(<ResizeHandle onResize={onResize} />);

    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 480 }); // moved left by 20
    fireEvent.mouseUp(document);

    // delta = 480 - 500 = -20 → panel grows (handle moved left)
    expect(onResize).toHaveBeenCalledWith(-20);
  });

  it('stops firing after mouseUp', () => {
    const onResize = vi.fn();
    render(<ResizeHandle onResize={onResize} />);

    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseUp(document);
    fireEvent.mouseMove(document, { clientX: 450 });

    expect(onResize).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd /Users/edward/MyFolder/claudecodeui && npx vitest run src/components/right-panel/__tests__/ResizeHandle.test.tsx 2>&1 | tail -20
```

Expected: `Cannot find module '../ResizeHandle'`.

- [ ] **Step 3: Implement `ResizeHandle`**

Create `src/components/right-panel/ResizeHandle.tsx`:

```tsx
import { useCallback, useEffect, useRef } from 'react';

interface ResizeHandleProps {
  /** Called during mousemove with (currentX - startX) since last event. */
  onResize: (delta: number) => void;
}

export default function ResizeHandle({ onResize }: ResizeHandleProps) {
  const isDraggingRef = useRef(false);
  const lastXRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDraggingRef.current = true;
    lastXRef.current = e.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = e.clientX - lastXRef.current;
      lastXRef.current = e.clientX;
      onResize(delta);
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [onResize]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      onMouseDown={handleMouseDown}
      className="w-1.5 flex-shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-border active:bg-primary/40"
    />
  );
}
```

- [ ] **Step 4: Run tests — expect all 3 to pass**

```bash
cd /Users/edward/MyFolder/claudecodeui && npx vitest run src/components/right-panel/__tests__/ResizeHandle.test.tsx 2>&1 | tail -20
```

Expected: `Tests 3 passed (3)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/edward/MyFolder/claudecodeui
git add src/components/right-panel/ResizeHandle.tsx src/components/right-panel/__tests__/ResizeHandle.test.tsx
git commit -m "feat: add ResizeHandle component"
```

---

## Task 3: `RightPanel` component

**Files:**
- Create: `src/components/right-panel/RightPanel.tsx`
- Create: `src/components/right-panel/__tests__/RightPanel.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/components/right-panel/__tests__/RightPanel.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import RightPanel from '../RightPanel';

// Stub heavy components so tests stay fast
vi.mock('../../../components/file-tree/view/FileTree', () => ({
  default: () => <div data-testid="file-tree" />,
}));
vi.mock('../../../components/git-panel/view/GitPanel', () => ({
  default: () => <div data-testid="git-panel" />,
}));

const baseProps = {
  activeTab: 'files' as const,
  onTabChange: vi.fn(),
  onClose: vi.fn(),
  selectedProject: null,
};

describe('RightPanel', () => {
  it('shows "Files" and "Git" tab buttons', () => {
    render(<RightPanel {...baseProps} />);
    expect(screen.getByRole('button', { name: /files/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /git/i })).toBeInTheDocument();
  });

  it('renders FileTree when activeTab is "files"', () => {
    render(<RightPanel {...baseProps} activeTab="files" />);
    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
  });

  it('renders GitPanel when activeTab is "git"', () => {
    render(<RightPanel {...baseProps} activeTab="git" />);
    expect(screen.getByTestId('git-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tree')).not.toBeInTheDocument();
  });

  it('calls onTabChange when Git tab is clicked', () => {
    const onTabChange = vi.fn();
    render(<RightPanel {...baseProps} onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole('button', { name: /git/i }));
    expect(onTabChange).toHaveBeenCalledWith('git');
  });

  it('calls onClose when ✕ button is clicked', () => {
    const onClose = vi.fn();
    render(<RightPanel {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd /Users/edward/MyFolder/claudecodeui && npx vitest run src/components/right-panel/__tests__/RightPanel.test.tsx 2>&1 | tail -20
```

Expected: `Cannot find module '../RightPanel'`.

- [ ] **Step 3: Implement `RightPanel`**

Create `src/components/right-panel/RightPanel.tsx`:

```tsx
import { X } from 'lucide-react';
import FileTree from '../file-tree/view/FileTree';
import GitPanel from '../git-panel/view/GitPanel';
import type { RightPanelTab } from '../../hooks/useChatRightPanel';
import type { Project } from '../../types/app';

interface RightPanelProps {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  onClose: () => void;
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
}

export default function RightPanel({
  activeTab,
  onTabChange,
  onClose,
  selectedProject,
  onFileOpen,
}: RightPanelProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border/60 bg-background">
      {/* Panel header */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <button
          role="button"
          aria-label="Files"
          onClick={() => onTabChange('files')}
          className={`rounded px-2.5 py-1 text-sm font-medium transition-colors ${
            activeTab === 'files'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Files
        </button>
        <button
          role="button"
          aria-label="Git"
          onClick={() => onTabChange('git')}
          className={`rounded px-2.5 py-1 text-sm font-medium transition-colors ${
            activeTab === 'git'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Git
        </button>

        <div className="flex-1" />

        <button
          aria-label="Close panel"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Panel content */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'files' ? (
          <FileTree selectedProject={selectedProject} onFileOpen={onFileOpen} />
        ) : (
          <GitPanel selectedProject={selectedProject} onFileOpen={onFileOpen} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests — expect all 5 to pass**

```bash
cd /Users/edward/MyFolder/claudecodeui && npx vitest run src/components/right-panel/__tests__/RightPanel.test.tsx 2>&1 | tail -20
```

Expected: `Tests 5 passed (5)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/edward/MyFolder/claudecodeui
git add src/components/right-panel/RightPanel.tsx src/components/right-panel/__tests__/RightPanel.test.tsx
git commit -m "feat: add RightPanel component (Files/Git tabs)"
```

---

## Task 4: Wire toggle buttons into `MainContentHeader`

**Files:**
- Modify: `src/components/main-content/types/types.ts` (lines around `MainContentHeaderProps`)
- Modify: `src/components/main-content/view/subcomponents/MainContentHeader.tsx`

- [ ] **Step 1: Extend `MainContentHeaderProps` in `types/types.ts`**

In `src/components/main-content/types/types.ts`, find `MainContentHeaderProps` and add three new optional props:

```ts
export type MainContentHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  // Right-panel toggle buttons (only rendered when activeTab === 'chat')
  onToggleFiles?: () => void;
  onToggleGit?: () => void;
  rightPanelOpen?: boolean;
  rightPanelActiveTab?: 'files' | 'git';
};
```

- [ ] **Step 2: Add toggle buttons in `MainContentHeader.tsx`**

In `src/components/main-content/view/subcomponents/MainContentHeader.tsx`:

1. Add import at top:
```tsx
import { Folder, GitBranch } from 'lucide-react';
```

2. Destructure the new props in the function signature:
```tsx
export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
  onToggleFiles,
  onToggleGit,
  rightPanelOpen,
  rightPanelActiveTab,
}: MainContentHeaderProps) {
```

3. After the closing `</div>` of `<div className="relative min-w-0 flex-shrink overflow-hidden sm:flex-shrink-0">` (which contains the tab switcher), add this block. It goes inside the outer `<div className="flex items-center justify-between gap-3">`:

```tsx
{activeTab === 'chat' && (onToggleFiles || onToggleGit) && (
  <div className="flex flex-shrink-0 items-center gap-1">
    <button
      aria-label="Toggle files panel"
      title="Files"
      onClick={onToggleFiles}
      className={`rounded p-1.5 transition-colors ${
        rightPanelOpen && rightPanelActiveTab === 'files'
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <Folder className="h-4 w-4" />
    </button>
    <button
      aria-label="Toggle git panel"
      title="Source Control"
      onClick={onToggleGit}
      className={`rounded p-1.5 transition-colors ${
        rightPanelOpen && rightPanelActiveTab === 'git'
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <GitBranch className="h-4 w-4" />
    </button>
  </div>
)}
```

The complete updated `return` block in `MainContentHeader.tsx` looks like:

```tsx
return (
  <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-4 sm:px-4 sm:py-5">
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        <MainContentTitle
          activeTab={activeTab}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          shouldShowTasksTab={shouldShowTasksTab}
        />
      </div>

      <div className="relative min-w-0 flex-shrink overflow-hidden sm:flex-shrink-0">
        {canScrollLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
        )}
        <div
          ref={scrollRef}
          onScroll={updateScrollState}
          className="scrollbar-hide overflow-x-auto"
        >
          <MainContentTabSwitcher
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            shouldShowTasksTab={shouldShowTasksTab}
          />
        </div>
        {canScrollRight && (
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
        )}
      </div>

      {activeTab === 'chat' && (onToggleFiles || onToggleGit) && (
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            aria-label="Toggle files panel"
            title="Files"
            onClick={onToggleFiles}
            className={`rounded p-1.5 transition-colors ${
              rightPanelOpen && rightPanelActiveTab === 'files'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Folder className="h-4 w-4" />
          </button>
          <button
            aria-label="Toggle git panel"
            title="Source Control"
            onClick={onToggleGit}
            className={`rounded p-1.5 transition-colors ${
              rightPanelOpen && rightPanelActiveTab === 'git'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <GitBranch className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  </div>
);
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/edward/MyFolder/claudecodeui && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS|MainContent" | head -20
```

Expected: no errors for the modified files.

- [ ] **Step 4: Commit**

```bash
cd /Users/edward/MyFolder/claudecodeui
git add src/components/main-content/types/types.ts src/components/main-content/view/subcomponents/MainContentHeader.tsx
git commit -m "feat: add Files/Git toggle buttons to chat header"
```

---

## Task 5: Wire panel into `MainContent.tsx`

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`

- [ ] **Step 1: Add imports**

At the top of `src/components/main-content/view/MainContent.tsx`, add after the existing imports:

```tsx
import { useChatRightPanel } from '../../../hooks/useChatRightPanel';
import RightPanel from '../../right-panel/RightPanel';
import ResizeHandle from '../../right-panel/ResizeHandle';
```

- [ ] **Step 2: Call the hook**

Inside the `MainContent` function body, after the `useEditorSidebar` hook call, add:

```tsx
const {
  state: rightPanelState,
  toggle: toggleRightPanel,
  close: closeRightPanel,
  setWidth: setRightPanelWidth,
} = useChatRightPanel();
```

- [ ] **Step 3: Thread toggle callbacks down to `MainContentHeader`**

In the JSX, find the `<MainContentHeader ... />` call and add four new props:

```tsx
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
```

- [ ] **Step 4: Add ResizeHandle + RightPanel to the flex container**

The current flex container (line 111) contains the chat column on the left and `<EditorSidebar>` on the right. We insert the resize handle and right panel **between the chat column and EditorSidebar**, but only when `rightPanelState.open` is true.

The right panel must be hidden when `editorExpanded` is true (same as how the chat column gets `hidden`).

Replace the inner `<div className="flex min-h-0 flex-1 overflow-hidden">` block with:

```tsx
<div className="flex min-h-0 flex-1 overflow-hidden">
  {/* Chat column (and other tabs) */}
  <div
    className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''}`}
    style={
      rightPanelState.open && !editorExpanded
        ? { width: `calc(100% - ${rightPanelState.width}px)`, flex: 'none' }
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

    {activeTab === 'files' && (
      <div className="h-full overflow-hidden">
        <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
      </div>
    )}

    <div className={`h-full w-full overflow-hidden ${activeTab === 'shell' ? 'block' : 'hidden'}`}>
      <ShellSessionPool
        project={selectedProject}
        activeSession={selectedSession}
        isActive={activeTab === 'shell'}
      />
    </div>

    {activeTab === 'git' && (
      <div className="h-full overflow-hidden">
        <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
      </div>
    )}

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

  {/* Right panel (Files / Git) — hidden when editor is expanded */}
  {rightPanelState.open && !editorExpanded && (
    <>
      <ResizeHandle
        onResize={(delta) => setRightPanelWidth(rightPanelState.width - delta)}
      />
      <div style={{ width: rightPanelState.width, flexShrink: 0 }} className="flex min-h-0 flex-col overflow-hidden">
        <RightPanel
          activeTab={rightPanelState.activeTab}
          onTabChange={(tab) => toggleRightPanel(tab)}
          onClose={closeRightPanel}
          selectedProject={selectedProject}
          onFileOpen={handleFileOpen}
        />
      </div>
    </>
  )}

  <EditorSidebar
    editingFile={editingFile}
    isMobile={isMobile}
    editorExpanded={editorExpanded}
    editorWidth={editorWidth}
    hasManualWidth={hasManualWidth}
    resizeHandleRef={resizeHandleRef}
    onResizeStart={handleResizeStart}
    onCloseEditor={handleCloseEditor}
    onToggleEditorExpand={handleToggleEditorExpand}
    projectPath={selectedProject.path}
    fillSpace={activeTab === 'files'}
  />
</div>
```

**Note on ResizeHandle delta math:** `onResize` receives delta = currentX - prevX. If user drags left (delta < 0), the handle moved toward the chat area → panel should grow. `newWidth = prev.width - delta`. This is passed directly: `setRightPanelWidth(rightPanelState.width - delta)`. The hook clamps to [200, 800] automatically.

- [ ] **Step 5: Typecheck the entire frontend**

```bash
cd /Users/edward/MyFolder/claudecodeui && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | head -20
```

Expected: zero errors.

- [ ] **Step 6: Run all frontend tests**

```bash
cd /Users/edward/MyFolder/claudecodeui && npx vitest run src/ 2>&1 | tail -20
```

Expected: all tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
cd /Users/edward/MyFolder/claudecodeui
git add src/components/main-content/view/MainContent.tsx
git commit -m "feat: wire chat right panel into MainContent layout"
```

---

## Task 6: Manual smoke test

- [ ] **Step 1: Start dev server**

In `claudecodeui` tmux session:

```bash
bash start-dev.sh
```

Wait for both the Express server (port 3003) and Vite (port 5175) to be ready.

- [ ] **Step 2: Open browser and verify**

Open `http://localhost:5175`. Select a project with an existing session.

Verify these interactions (from the spec interaction model):

| Action | Expected result |
|--------|----------------|
| Click 📁 (panel closed) | Panel opens on Files tab, chat column narrows |
| Click 📁 again (panel open on Files) | Panel closes, chat column returns to full width |
| Click 🔀 (panel closed) | Panel opens on Git tab |
| Click 📁 (panel open on Git) | Switches to Files tab |
| Drag resize handle left | Panel grows, chat shrinks |
| Drag resize handle right | Panel shrinks, chat grows |
| Width reaches 200px | Cannot drag smaller |
| Click ✕ in panel header | Panel closes |
| Reload page | Panel state restored from localStorage |
| Switch to Files/Git/Shell tab | Toggle buttons disappear from header |

- [ ] **Step 3: Commit any visual tweaks** (if needed)

```bash
git add -p && git commit -m "fix: right panel visual tweaks"
```

---

## Self-Review Checklist

- **Spec coverage:**
  - ✅ Toggle icons in chat header (📁 / 🔀) — Task 4
  - ✅ Panel opens/switches/closes per interaction table — `useChatRightPanel.toggle()` logic
  - ✅ ResizeHandle drag — Task 2
  - ✅ Width clamped 200–800px — `useChatRightPanel.setWidth` + hook clamp
  - ✅ localStorage persistence (`rightPanel.state`) — Task 1
  - ✅ `RightPanel` renders `FileTree` / `GitPanel` — Task 3
  - ✅ Insertion point: `MainContent.tsx` — Task 5
  - ✅ Panel hidden when editor is expanded — Task 5
  - ✅ Out-of-scope items not implemented (mobile, keyboard shortcut, per-project state)

- **Type consistency:**
  - `RightPanelTab` exported from `useChatRightPanel.ts` and re-used in `RightPanel.tsx`
  - `onTabChange: (tab: RightPanelTab) => void` in `RightPanel` matches `toggle(tab)` signature
  - `MainContentHeaderProps.rightPanelActiveTab: 'files' | 'git'` matches `RightPanelTab`
