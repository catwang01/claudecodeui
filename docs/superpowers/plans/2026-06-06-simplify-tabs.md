# Simplify Left Tab Bar — Remove Files/Git from AppTab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove `'files'` and `'git'` from the left tab bar; they are now exclusively accessible via the right panel toggle buttons (📁/🔀).

**Architecture:** Delete `'files'` and `'git'` from the `AppTab` union type, then use TypeScript errors as a guide to remove all dead code (render blocks, imports, title branches). Finally, remove the `activeTab === 'chat'` guard so the toggle buttons appear on all left tabs.

**Tech Stack:** TypeScript, React 18, Vite, Vitest

---

## File Map

| File | Change |
|------|--------|
| `src/types/app.ts` | Remove `'files' \| 'git'` from `AppTab` union |
| `src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx` | Remove `files` + `git` from `BASE_TABS`; remove `Folder`, `GitBranch` from import |
| `src/components/main-content/view/MainContent.tsx` | Remove `FileTree` + `GitPanel` imports; remove two conditional render blocks; change `fillSpace={activeTab === 'files'}` → `fillSpace={false}` |
| `src/components/main-content/view/subcomponents/MainContentHeader.tsx` | Remove `activeTab === 'chat' &&` guard from toggle button container |
| `src/components/main-content/view/subcomponents/MainContentTitle.tsx` | Remove `'files'` and `'git'` branches from `getTabTitle` |

> **⚠️ Do NOT touch `src/components/settings/view/Settings.tsx`.**
> The `activeTab === 'git'` on line 172 of that file is the Settings panel's internal tab state — it has nothing to do with `AppTab` and is a false positive.

---

### Task 1: Remove `'files'` and `'git'` from AppTab

**Files:**
- Modify: `src/types/app.ts:3`

- [x] **Step 1: Edit the type**

Open `src/types/app.ts` and change line 3:

```ts
// Before
export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'preview' | `plugin:${string}`;

// After
export type AppTab = 'chat' | 'shell' | 'tasks' | 'preview' | `plugin:${string}`;
```

- [x] **Step 2: Verify TypeScript now flags all dead references**

Run: `cd /Users/edward/MyFolder/claudecodeui && npx tsc --noEmit 2>&1 | head -60`

Expected: TypeScript errors referencing `'files'` and `'git'` in the four files listed in the File Map above. If errors appear in other files, note them for the cleanup tasks below.

- [x] **Step 3: Commit the type change alone**

```bash
git add src/types/app.ts
git commit -m "refactor: remove 'files' and 'git' from AppTab union"
```

---

### Task 2: Remove files/git tabs from MainContentTabSwitcher

**Files:**
- Modify: `src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx`

- [x] **Step 1: Remove unused icons from the import and remove the two tab entries**

Change line 1 — remove `Folder` and `GitBranch`:
```tsx
// Before
import { MessageSquare, Terminal, Folder, GitBranch, ClipboardCheck, type LucideIcon } from 'lucide-react';

// After
import { MessageSquare, Terminal, ClipboardCheck, type LucideIcon } from 'lucide-react';
```

Change lines 32–37 — remove the `files` and `git` entries:
```tsx
// Before
const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

// After
const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
];
```

- [x] **Step 2: Verify no TypeScript errors in this file**

Run: `npx tsc --noEmit 2>&1 | grep MainContentTabSwitcher`

Expected: no output (no errors in this file).

- [x] **Step 3: Commit**

```bash
git add src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx
git commit -m "refactor: remove files/git tabs from left tab bar"
```

---

### Task 3: Remove FileTree/GitPanel blocks from MainContent

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`

- [x] **Step 1: Remove the two unused imports (lines 3 and 5)**

```tsx
// Remove line 3:
import FileTree from '../../file-tree/view/FileTree';

// Remove line 5:
import GitPanel from '../../git-panel/view/GitPanel';
```

After removal the imports section should start:
```tsx
import React, { useCallback, useEffect } from 'react';
import ChatInterface from '../../chat/view/ChatInterface';
import ShellSessionPool from '../../shell-pool/ShellSessionPool';
import PluginTabContent from '../../plugins/view/PluginTabContent';
```

- [x] **Step 2: Remove the `activeTab === 'files'` render block (was lines 171–175)**

Remove this entire block:
```tsx
{activeTab === 'files' && (
  <div className="h-full overflow-hidden">
    <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
  </div>
)}
```

- [x] **Step 3: Remove the `activeTab === 'git'` render block (was lines 185–189)**

Remove this entire block:
```tsx
{activeTab === 'git' && (
  <div className="h-full overflow-hidden">
    <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
  </div>
)}
```

- [x] **Step 4: Fix `fillSpace` prop on `<EditorSidebar>` (was line 235)**

```tsx
// Before
fillSpace={activeTab === 'files'}

// After
fillSpace={false}
```

- [x] **Step 5: Verify no TypeScript errors in this file**

Run: `npx tsc --noEmit 2>&1 | grep MainContent`

Expected: no output.

- [x] **Step 6: Commit**

```bash
git add src/components/main-content/view/MainContent.tsx
git commit -m "refactor: remove FileTree/GitPanel render blocks from MainContent"
```

---

### Task 4: Remove `activeTab === 'chat'` guard from toggle buttons

**Files:**
- Modify: `src/components/main-content/view/subcomponents/MainContentHeader.tsx`

- [x] **Step 1: Remove the `activeTab === 'chat' &&` guard**

Current line 74:
```tsx
{activeTab === 'chat' && (onToggleFiles || onToggleGit) && (
```

Change to:
```tsx
{(onToggleFiles || onToggleGit) && (
```

The full toggle button container after the change:
```tsx
{(onToggleFiles || onToggleGit) && (
  <div className="flex flex-shrink-0 items-center gap-1">
    {onToggleFiles && (
      <button
        aria-label="Toggle files panel"
        aria-pressed={rightPanelOpen && rightPanelActiveTab === 'files'}
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
    )}
    {onToggleGit && (
      <button
        aria-label="Toggle git panel"
        aria-pressed={rightPanelOpen && rightPanelActiveTab === 'git'}
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
    )}
  </div>
)}
```

- [x] **Step 2: Verify no TypeScript errors in this file**

Run: `npx tsc --noEmit 2>&1 | grep MainContentHeader`

Expected: no output.

- [x] **Step 3: Commit**

```bash
git add src/components/main-content/view/subcomponents/MainContentHeader.tsx
git commit -m "feat: show files/git toggle buttons on all left tabs, not just chat"
```

---

### Task 5: Remove dead branches from MainContentTitle

**Files:**
- Modify: `src/components/main-content/view/subcomponents/MainContentTitle.tsx`

- [x] **Step 1: Remove the `'files'` and `'git'` branches from `getTabTitle`**

Current `getTabTitle` function (lines 17–35):
```tsx
function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  return 'Project';
}
```

After removing the two dead branches:
```tsx
function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  return 'Project';
}
```

- [x] **Step 2: Verify no TypeScript errors in the whole project**

Run: `npx tsc --noEmit 2>&1`

Expected: **no output** (zero errors). If any errors remain, fix them before committing.

- [x] **Step 3: Commit**

```bash
git add src/components/main-content/view/subcomponents/MainContentTitle.tsx
git commit -m "refactor: remove files/git title branches from MainContentTitle"
```

---

### Task 6: Full test run + verification

**Files:** (none created or modified — verification only)

- [x] **Step 1: Run the full test suite**

Run: `cd /Users/edward/MyFolder/claudecodeui && npm test -- --run 2>&1 | tail -30`

Expected: all tests pass (73 tests from previous baseline). If any tests fail, fix them before continuing.

- [x] **Step 2: Verify TypeScript is fully clean**

Run: `npx tsc --noEmit`

Expected: no output.

- [x] **Step 3: Spot-check the UI behaviour in your head**

Confirm the logic is correct:
- Left tab bar shows: Chat, Shell, (Tasks if installed), (Plugin tabs if enabled)
- `📁` and `🔀` toggle buttons appear on Chat tab, Shell tab, Tasks tab, and Plugin tabs
- Clicking `📁` opens the right panel with FileTree
- Clicking `🔀` opens the right panel with GitPanel
- The right panel remains resizable and closeable
- `EditorSidebar` `fillSpace` is always `false` (no longer depends on active tab)

- [x] **Step 4: Final summary commit (if anything was uncommitted)**

If all tasks were committed individually above, nothing to do here. Otherwise:

```bash
git add -p
git commit -m "refactor: simplify left tab bar — files/git moved exclusively to right panel"
```
