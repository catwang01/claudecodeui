# Recent Session Project Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add clickable project filter badges to the Recent sessions view in the sidebar, with auto-assigned colors derived from project names.

**Architecture:** All changes are purely frontend. A `getProjectColor()` utility hashes project names to a fixed color palette. `SidebarContent.tsx` gains a `selectedProjectFilter` state, renders a badge row above the session list, and filters `recentSessions` by the active project. Each session row gets a colored dot matching its project color.

**Tech Stack:** React 18, TypeScript, Tailwind CSS (inline styles for dynamic colors to avoid purge issues)

---

### Task 1: Add `getProjectColor` utility to sidebar utils

**Files:**
- Modify: `src/components/sidebar/utils/utils.ts`

- [ ] **Step 1: Read the existing utils file to find a safe insertion point**

Read `src/components/sidebar/utils/utils.ts` and note the last export before adding the new function.

- [ ] **Step 2: Add the color palette and hash function**

Add at the end of `src/components/sidebar/utils/utils.ts`:

```typescript
export type ProjectColor = {
  dot: string;       // CSS color for the indicator dot
  bg: string;        // Semi-transparent background for badge
  border: string;    // Border color for badge
  text: string;      // Text color for badge
};

const PROJECT_COLOR_PALETTE: ProjectColor[] = [
  { dot: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.4)', text: '#a78bfa' },
  { dot: '#14b8a6', bg: 'rgba(20,184,166,0.12)',  border: 'rgba(20,184,166,0.4)',  text: '#2dd4bf' },
  { dot: '#f97316', bg: 'rgba(249,115,22,0.12)',  border: 'rgba(249,115,22,0.4)',  text: '#fb923c' },
  { dot: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.4)',  text: '#60a5fa' },
  { dot: '#ec4899', bg: 'rgba(236,72,153,0.12)',  border: 'rgba(236,72,153,0.4)',  text: '#f472b6' },
  { dot: '#22c55e', bg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.4)',   text: '#4ade80' },
  { dot: '#eab308', bg: 'rgba(234,179,8,0.12)',   border: 'rgba(234,179,8,0.4)',   text: '#fbbf24' },
  { dot: '#ef4444', bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.4)',   text: '#f87171' },
  { dot: '#6366f1', bg: 'rgba(99,102,241,0.12)',  border: 'rgba(99,102,241,0.4)',  text: '#818cf8' },
  { dot: '#06b6d4', bg: 'rgba(6,182,212,0.12)',   border: 'rgba(6,182,212,0.4)',   text: '#22d3ee' },
];

export function getProjectColor(projectName: string): ProjectColor {
  let hash = 0;
  for (let i = 0; i < projectName.length; i++) {
    hash = (hash * 31 + projectName.charCodeAt(i)) & 0xffffffff;
  }
  return PROJECT_COLOR_PALETTE[Math.abs(hash) % PROJECT_COLOR_PALETTE.length];
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/tanhuan/claudecodeui && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to utils.ts

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebar/utils/utils.ts
git commit -m "feat(sidebar): add getProjectColor utility for project badge colors"
```

---

### Task 2: Add project filter badges and colored dots to Recent view

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`

- [ ] **Step 1: Import `useState` and `getProjectColor`**

At the top of `SidebarContent.tsx`, change:

```typescript
import { useMemo, type ReactNode } from 'react';
```

to:

```typescript
import { useMemo, useState, type ReactNode } from 'react';
```

And add to the existing utils import:

```typescript
import { getSessionName, getProjectColor } from '../../utils/utils';
```

- [ ] **Step 2: Add `selectedProjectFilter` state and `projectBadges` memo inside the component**

Inside the `SidebarContent` component function, directly after the `recentSessions` useMemo (around line 116), add:

```typescript
const [selectedProjectFilter, setSelectedProjectFilter] = useState<string | null>(null);

const projectBadges = useMemo(() => {
  if (searchMode !== 'recent') return [];
  const counts = new Map<string, { project: Project; count: number }>();
  for (const { project } of recentSessions) {
    const existing = counts.get(project.name);
    if (existing) {
      existing.count++;
    } else {
      counts.set(project.name, { project, count: 1 });
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count);
}, [searchMode, recentSessions]);

const filteredRecentSessions = useMemo(() => {
  if (!selectedProjectFilter) return recentSessions;
  return recentSessions.filter(({ project }) => project.name === selectedProjectFilter);
}, [recentSessions, selectedProjectFilter]);
```

- [ ] **Step 3: Render badge row + use `filteredRecentSessions` + colored dots**

Replace the entire Recent sessions render block (the `searchMode === 'recent' && !showConversationSearch` branch). Find this block starting at line 141:

```typescript
        {searchMode === 'recent' && !showConversationSearch ? (
          <div className="space-y-1 px-2 py-1">
            {recentSessions.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <Clock className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No recent sessions</p>
              </div>
            ) : recentSessions.map(({ session, project }) => {
              const isProcessing = projectListProps.processingSessions?.has(session.id) ?? false;
              const sessionDate = new Date(session.lastActivity || session.createdAt || 0);
              const isActive = (projectListProps.currentTime.getTime() - sessionDate.getTime()) / 60000 < 10;
              return (
              <div key={`${project.name}-${session.id}`} className="relative">
                {isProcessing && (
                  <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2">
                    <div className="h-2 w-2 animate-spin rounded-full border border-yellow-400 border-t-transparent" />
                  </div>
                )}
                {!isProcessing && isActive && (
                  <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2">
                    <div className="h-2 w-2 rounded-full bg-blue-500" />
                  </div>
                )}
                <button
                  className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50"
                  onClick={() => projectListProps.onSessionSelect(session, project.name)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <SessionProviderLogo provider={session.__provider} className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate text-xs font-medium text-foreground flex-1">
                      {getSessionName(session, t)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 pl-5">
                    <Folder className="h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/60" />
                    <span className="truncate text-[10px] text-muted-foreground/60">{project.displayName || project.name}</span>
                    <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/50">
                      {formatTimeAgo(session.lastActivity || session.createdAt || '', projectListProps.currentTime, t)}
                    </span>
                  </div>
                </button>
              </div>
              );
            })}
          </div>
```

Replace with:

```typescript
        {searchMode === 'recent' && !showConversationSearch ? (
          <div className="space-y-1 px-2 py-1">
            {/* Project filter badges */}
            {projectBadges.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-2 pt-1">
                {projectBadges.map(({ project, count }) => {
                  const color = getProjectColor(project.name);
                  const isSelected = selectedProjectFilter === project.name;
                  return (
                    <button
                      key={project.name}
                      onClick={() =>
                        setSelectedProjectFilter(isSelected ? null : project.name)
                      }
                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all"
                      style={{
                        background: isSelected ? color.dot : color.bg,
                        border: `1px solid ${isSelected ? color.dot : color.border}`,
                        color: isSelected ? '#ffffff' : color.text,
                      }}
                    >
                      <span className="max-w-[80px] truncate">{project.displayName || project.name}</span>
                      <span style={{ opacity: isSelected ? 0.85 : 0.7 }}>{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {filteredRecentSessions.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <Clock className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No recent sessions</p>
              </div>
            ) : filteredRecentSessions.map(({ session, project }) => {
              const color = getProjectColor(project.name);
              const isProcessing = projectListProps.processingSessions?.has(session.id) ?? false;
              const sessionDate = new Date(session.lastActivity || session.createdAt || 0);
              const isActive = (projectListProps.currentTime.getTime() - sessionDate.getTime()) / 60000 < 10;
              return (
              <div key={`${project.name}-${session.id}`} className="relative">
                {isProcessing && (
                  <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2">
                    <div className="h-2 w-2 animate-spin rounded-full border border-yellow-400 border-t-transparent" />
                  </div>
                )}
                {!isProcessing && isActive && (
                  <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2">
                    <div className="h-2 w-2 rounded-full bg-blue-500" />
                  </div>
                )}
                <button
                  className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50"
                  onClick={() => projectListProps.onSessionSelect(session, project.name)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ background: color.dot }}
                    />
                    <SessionProviderLogo provider={session.__provider} className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate text-xs font-medium text-foreground flex-1">
                      {getSessionName(session, t)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 pl-5">
                    <Folder className="h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/60" />
                    <span className="truncate text-[10px] text-muted-foreground/60">{project.displayName || project.name}</span>
                    <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/50">
                      {formatTimeAgo(session.lastActivity || session.createdAt || '', projectListProps.currentTime, t)}
                    </span>
                  </div>
                </button>
              </div>
              );
            })}
          </div>
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/tanhuan/claudecodeui && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 6: Start dev server and verify visually**

```bash
cd /Users/tanhuan/claudecodeui && npm run dev
```

Open the app, click "Recent" tab in sidebar. Verify:
- Colored badges appear at top with project name and session count
- Clicking a badge highlights it (solid background) and filters the list
- Clicking the same badge again shows all sessions
- Each session row has a small colored dot matching its project badge color

- [ ] **Step 7: Commit**

```bash
git add src/components/sidebar/view/subcomponents/SidebarContent.tsx
git commit -m "feat(sidebar): add project filter badges to Recent sessions view"
```
