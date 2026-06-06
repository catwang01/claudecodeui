# Simplify Left Tab Bar — Files/Git Move to Right Panel

**Date:** 2026-06-06  
**Status:** Approved

---

## Overview

Remove `files` and `git` from the left-side tab bar. They are now exclusively accessible via the right panel (📁/🔀 toggle buttons). The left tab bar retains: Chat, Shell, Tasks, Plugin tabs.

The right panel (built in the previous feature) is unchanged in structure; only the entry point changes — toggle buttons now appear on **all** left tabs, not just Chat.

---

## Layout

### Right panel open
```
┌──Sidebar──┬──── Left column ─────────────────────┬──── Right ────────┐
│  Session  │ [Chat][Shell][Tasks]  [📁][🔀]        │ [Files][Git]  [✕] │
│  List     ├──────────────────────────────────────┼───────────────────┤
│           │  Chat / Shell / Tasks content         │  FileTree /       │
│           │                                      │  GitPanel         │
└───────────┴──────────────────────────────────────┴───────────────────┘
```

### Right panel closed
```
┌──Sidebar──┬──── Left column (full width) ────────────────────────────┐
│  Session  │ [Chat][Shell][Tasks]  [📁][🔀]                           │
│  List     ├──────────────────────────────────────────────────────────┤
│           │  Chat / Shell / Tasks content                            │
└───────────┴──────────────────────────────────────────────────────────┘
```

---

## Changes Required

### 1. `src/types/app.ts`
Remove `'files'` and `'git'` from the `AppTab` union:

```ts
// Before
export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'preview' | `plugin:${string}`;

// After
export type AppTab = 'chat' | 'shell' | 'tasks' | 'preview' | `plugin:${string}`;
```

### 2. `src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx`
Remove the Files (Folder icon) and Git (GitBranch icon) tab buttons. Only Chat, Shell, Tasks, and Plugin tabs remain.

### 3. `src/components/main-content/view/MainContent.tsx`
- Remove the `{activeTab === 'files' && <FileTree .../>}` block from the left column
- Remove the `{activeTab === 'git' && <GitPanel .../>}` block from the left column
- Fix the `fillSpace` prop on `<EditorSidebar>`: currently `fillSpace={activeTab === 'files'}` — change to `fillSpace={false}` (or remove the prop, it's no longer needed since Files is always in the right panel)

### 4. `src/components/main-content/view/subcomponents/MainContentHeader.tsx`
Remove the `activeTab === 'chat' &&` guard from the toggle button container. The 📁/🔀 buttons now appear on all left tabs:

```tsx
// Before
{activeTab === 'chat' && (onToggleFiles || onToggleGit) && (

// After
{(onToggleFiles || onToggleGit) && (
```

### 5. `src/components/main-content/view/subcomponents/MainContentTitle.tsx`
Remove branches that check `activeTab === 'files'` and `activeTab === 'git'` — these cases no longer exist.

### 6. `src/components/settings/view/Settings.tsx`
Remove or update the `activeTab === 'git'` conditional (line 172). Read the file to understand context before removing.

---

## Out of Scope

- `RightPanel.tsx` — unchanged; it uses `RightPanelTab` (`'files' | 'git'`), not `AppTab`
- `useChatRightPanel.ts` — unchanged
- `ResizeHandle.tsx` — unchanged
- Any server-side code — unchanged
- Mobile/responsive behavior — unchanged

---

## TypeScript Strategy

After removing `'files'`/`'git'` from `AppTab`, TypeScript will flag every remaining reference to those values as a type error. Use `npx tsc --noEmit` as a guide to find all cleanup sites. The five files listed above cover all known references.
