# Merge Code Preview into Right Panel

**Date:** 2026-06-06
**Status:** Approved

---

## Overview

Remove `EditorSidebar` as a separate third column. Instead, file preview opens as an `'editor'` tab inside the existing right panel. The right panel already houses Files and Git; adding a third tab for code preview eliminates the redundancy of two independent resizable side panels.

---

## Layout

### Right panel — editor tab, normal state
```
┌──Sidebar──┬──── Left column ─────────────────┬──── Right ────────────────┐
│  Session  │ [Chat][Shell]  [🔀][📁]           │ [Git][Files][Editor]  [✕] │
│  List     ├──────────────────────────────────┼───────────────────────────┤
│           │  Chat / Shell content             │  FileViewer               │
└───────────┴──────────────────────────────────┴───────────────────────────┘
```

### Right panel — editor tab, expanded state
```
┌──Sidebar──┬──── Left column (hidden) ─────────────────────────────────────┐
│  Session  │ [Chat][Shell]  [🔀][📁]     FileViewer (full width)  [↙] [✕] │
│  List     ├───────────────────────────────────────────────────────────────┤
│           │  FileViewer content                                            │
└───────────┴───────────────────────────────────────────────────────────────┘
```

---

## Changes Required

### 1. `src/hooks/useChatRightPanel.ts`

**Type change:**
```ts
// Before
export type RightPanelTab = 'files' | 'git';

// After
export type RightPanelTab = 'files' | 'git' | 'editor';
```

**State additions** (in-memory only, NOT persisted to localStorage):
```ts
export interface RightPanelState {
  open: boolean;
  activeTab: RightPanelTab;
  width: number;
  editingFile: CodeEditorFile | null;   // NEW — not persisted
  editorExpanded: boolean;              // NEW — not persisted
}
```

**`readInitialState` guard:** if localStorage has `activeTab: 'editor'`, fall back to `'files'` (file is not persisted so there would be nothing to show).

**New method `openFile(filePath: string, diffInfo?: CodeEditorDiffInfo | null)`:**
- Derives `name` from the path (last segment)
- Builds a `CodeEditorFile` object
- Sets `editingFile`, `activeTab: 'editor'`, `open: true`

**Pre-open snapshot** — in-memory only, not part of persisted state:
```ts
preFileOpenSnapshot: { open: boolean; activeTab: 'files' | 'git' } | null
```
`openFile()` saves the current `{ open, activeTab }` (coerced to `'files'` if it was `'editor'`) into `preFileOpenSnapshot` before switching to the editor tab.

**New method `closeFile()`:**
- Sets `editingFile: null`, `editorExpanded: false`, clears `preFileOpenSnapshot`
- Restores from snapshot:
  - Snapshot `open: false` → close the panel entirely (`open: false, activeTab: 'files'`)
  - Snapshot `open: true, activeTab: X` → keep panel open, switch to tab X

**New method `toggleEditorExpand()`:**
- Flips `editorExpanded`; only meaningful when `activeTab === 'editor'`

**Persist logic:** only persist `open`, `activeTab`, `width` — never `editingFile` or `editorExpanded`.

---

### 2. `src/components/right-panel/RightPanel.tsx`

**New props:**
```ts
interface RightPanelProps {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  onClose: () => void;
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  // NEW:
  editingFile: CodeEditorFile | null;
  editorExpanded: boolean;
  onCloseFile: () => void;
  onToggleEditorExpand: () => void;
  isMobile: boolean;
  projectPath?: string;
}
```

**Header tab:** add an `Editor` tab button, visible only when `editingFile !== null`. Clicking it calls `onTabChange('editor')`.

**Expand button:** render a collapse/expand icon in the header only when `activeTab === 'editor'`. Calls `onToggleEditorExpand`.

**Panel content:** add third branch:
```tsx
{activeTab === 'editor' && editingFile && (
  <FileViewer
    key={editingFile.path}
    file={editingFile}
    onClose={onCloseFile}
    projectPath={projectPath}
    isSidebar
    isExpanded={editorExpanded}
    onToggleExpand={onToggleEditorExpand}
    // no onPopOut — mobile is handled by isMobile prop passed to FileViewer
  />
)}
```

Mobile: when `isMobile` is true and `editingFile` is set, render a full-screen `FileViewer` overlay (same behavior as the old `poppedOut` logic in `EditorSidebar`).

---

### 3. `src/components/main-content/view/MainContent.tsx`

- **Remove** `useEditorSidebar` import and call
- **Remove** `<EditorSidebar .../>` from the render tree
- **Add** `openFile` / `closeFile` / `toggleEditorExpand` from `useChatRightPanel`
- Pass `onFileOpen={openFile}` everywhere that previously received `handleFileOpen`
- **Expand logic:** when `editorExpanded` is true, add `hidden` class to the left column div (same pattern as the old `editorExpanded` hide)
- **Right panel div** gains `flex-1` when `editorExpanded` (instead of the fixed `rightPanelState.width`-based style)
- **Remove** `ResizeHandle` when `editorExpanded` (no left content to resize against)

---

### 4. Delete

- `src/components/code-editor/view/EditorSidebar.tsx`
- `src/components/code-editor/hooks/useEditorSidebar.ts`

---

## Out of Scope

- `FileViewer.tsx` — unchanged (used as-is inside `RightPanel`)
- `ResizeHandle.tsx` — unchanged
- Mobile pop-out: handled natively by passing `isMobile` to `FileViewer` inside `RightPanel`
- The 📁/🔀 header toggle buttons — unchanged; opening a file auto-opens the panel via `openFile()`

---

## State & Persistence

| Field          | Persisted | Notes |
|----------------|-----------|-------|
| `open`         | ✅ localStorage | |
| `activeTab`    | ✅ localStorage | `'editor'` value on load → falls back to `'files'` |
| `width`        | ✅ localStorage | |
| `editingFile`  | ❌ in-memory only | No cross-session file state |
| `editorExpanded` | ❌ in-memory only | Resets on reload |
| `preFileOpenSnapshot` | ❌ in-memory only | Discarded on closeFile() |

---

## TypeScript Strategy

After updating `RightPanelTab`, the compiler will flag any exhaustive switch/conditional on that type that doesn't handle `'editor'`. Use `npx tsc --noEmit` to find all sites.
