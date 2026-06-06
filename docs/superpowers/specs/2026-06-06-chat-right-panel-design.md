# Chat Right Panel — Files & Source Control

**Date:** 2026-06-06  
**Status:** Approved

---

## Overview

Add a toggleable, resizable right panel alongside the chat area that renders the existing `FileTree` or `GitPanel` components. Users can view files and git status while chatting without switching tabs.

---

## Layout

```
┌──Session──┬──────── Chat ────────┬──── Right Panel ────┐
│  Sidebar  │ Header      [📁][🔀] │  Files │ Git   [✕]  │
│           ├──────────────────────┼─────────────────────┤
│           │                      │                     │
│           │   Chat messages      │  FileTree /         │
│           │                      │  GitPanel           │
│           │                      │                     │
│           ├──────────────────────┤                     │
│           │   Input area         │                     │
└───────────┴──────────────────────┴─────────────────────┘
                                  ↑
                           drag-to-resize
```

The right panel sits alongside the full chat column (messages + input). A drag handle separates chat and panel; dragging left/right adjusts panel width.

---

## Interaction Model

### Toggle icons in chat header (top-right)
| User action | Result |
|---|---|
| Click 📁, panel closed | Open panel on **Files** tab |
| Click 🔀, panel closed | Open panel on **Git** tab |
| Click 📁, panel open on Files | **Close** panel |
| Click 🔀, panel open on Git | **Close** panel |
| Click 📁, panel open on Git | Switch to **Files** tab |
| Click 🔀, panel open on Files | Switch to **Git** tab |

### Panel header
- `Files | Git` tab switcher
- `✕` close button

### Resize
- Drag handle between chat and panel
- Width clamped: min 200px, max 800px (or 50% of container, whichever is smaller)
- Width persisted to `localStorage` key `rightPanel.width`

---

## State — `useChatRightPanel` hook

```ts
interface RightPanelState {
  open: boolean;
  activeTab: 'files' | 'git';
  width: number; // pixels
}
```

Persisted to `localStorage` key `rightPanel.state`. Defaults: `{ open: false, activeTab: 'files', width: 360 }`.

---

## Components

### New: `src/components/right-panel/RightPanel.tsx`
Props:
```ts
{
  activeTab: 'files' | 'git';
  onTabChange: (tab: 'files' | 'git') => void;
  onClose: () => void;
  selectedProject: Project | null;
}
```
Renders tab header + either `<FileTree>` or `<GitPanel>` depending on `activeTab`.

### New: `src/components/right-panel/ResizeHandle.tsx`
Props:
```ts
{
  onResize: (delta: number) => void; // called on mousemove
}
```
Thin vertical strip (6px wide). `mousedown` → listen to `mousemove`/`mouseup` on `document`.

### New: `src/hooks/useChatRightPanel.ts`
Returns `{ state, toggle(tab), close, setWidth }`. Handles localStorage read/write.

### Modified: where the chat layout lives
- Import and render `<ResizeHandle>` + `<RightPanel>` when `state.open`
- Add 📁 and 🔀 icon buttons to chat header calling `toggle('files')` / `toggle('git')`
- Apply `width: calc(100% - ${panelWidth}px)` to chat column when panel is open

---

## Where to insert in existing layout

The split lives in **`src/components/main-content/view/MainContent.tsx`**. It owns the main flex container (`flex min-h-0 flex-1`) that already includes an `EditorSidebar` on the right. The right panel and resize handle are added inside this same flex container, after the chat column — mirroring how `EditorSidebar` is mounted today.

`ChatInterface.tsx` is left untouched except for the header buttons (📁 / 🔀); all layout changes live in `MainContent.tsx` and the new `right-panel/` components.

---

## Out of Scope

- Mobile / small-screen behavior (panel hidden below a breakpoint, e.g. < 768px)
- Keyboard shortcut to toggle panel
- Remembering panel state per-project
