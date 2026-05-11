# At-Mention Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the @ mention dropdown in chat input to show projects (before files), with folder icon and "Project" badge.

**Architecture:** Add `type: 'file' | 'project'` to `MentionableFile`, extend `useFileMentions` to accept `allProjects: Project[]` and prepend matching projects to the dropdown list, thread `allProjects` down from `AppContent` through `MainContent` and `ChatInterface` to `useChatComposerState`, update `ChatComposer` dropdown JSX to render section headers and icons.

**Tech Stack:** React 18, TypeScript, Tailwind CSS

---

### Task 1: Extend MentionableFile type and update useFileMentions

**Files:**
- Modify: `src/components/chat/hooks/useFileMentions.tsx`

- [ ] **Step 1: Add `type` field to `MentionableFile` and update `UseFileMentionsOptions`**

In `useFileMentions.tsx`, change:

```typescript
export interface MentionableFile {
  name: string;
  path: string;
  type: 'file' | 'project';
  relativePath?: string;
}

interface UseFileMentionsOptions {
  selectedProject: Project | null;
  allProjects: Project[];
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
}
```

- [ ] **Step 2: Update `flattenFileTree` to set `type: 'file'`**

Change the push inside `flattenFileTree`:

```typescript
flattened.push({
  name: file.name,
  path: fullPath,
  type: 'file',
  relativePath: file.path,
});
```

- [ ] **Step 3: Update hook signature to accept `allProjects`**

Change the function signature:

```typescript
export function useFileMentions({ selectedProject, allProjects, input, setInput, textareaRef }: UseFileMentionsOptions) {
```

- [ ] **Step 4: Replace the `setFilteredFiles` call in the main `useEffect` with project+file filtering**

Replace the existing block (lines ~119-127):

```typescript
const matchingProjects = allProjects
  .filter(
    (project) =>
      project.displayName.toLowerCase().includes(textAfterAt.toLowerCase()) ||
      project.fullPath.toLowerCase().includes(textAfterAt.toLowerCase()),
  )
  .map((project) => ({
    name: project.displayName,
    path: project.fullPath,
    type: 'project' as const,
  }));

const matchingFiles = fileList
  .filter(
    (file) =>
      file.name.toLowerCase().includes(textAfterAt.toLowerCase()) ||
      file.path.toLowerCase().includes(textAfterAt.toLowerCase()),
  )
  .slice(0, 10)
  .map((file) => ({ ...file, type: 'file' as const }));

setFilteredFiles([...matchingProjects, ...matchingFiles]);
```

Also add `allProjects` to the `useEffect` dependency array:
```typescript
}, [input, cursorPosition, fileList, selectedProject?.name, allProjects]);
```

- [ ] **Step 5: Verify TypeScript compiles without errors**

```bash
cd "C:\Users\zhenwang\source\Repos\claudecodeui2\claudecodeui" && npx tsc --noEmit 2>&1 | head -30
```

Expected: errors only in files not yet updated (ChatComposer, useChatComposerState, etc.)

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/hooks/useFileMentions.tsx
git commit -m "feat(mentions): extend MentionableFile with type and add project filtering"
```

---

### Task 2: Update useChatComposerState to pass allProjects

**Files:**
- Modify: `src/components/chat/hooks/useChatComposerState.ts`

- [ ] **Step 1: Add `allProjects` to the options type in `useChatComposerState.ts`**

Find the options type definition (around line 33). Add:

```typescript
allProjects?: Project[];
```

- [ ] **Step 2: Destructure `allProjects` with default and pass to `useFileMentions`**

In the `useFileMentions` call (around line 382), change to:

```typescript
const {
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  renderInputWithMentions,
  selectFile,
  setCursorPosition,
  handleFileMentionsKeyDown,
} = useFileMentions({
  selectedProject,
  allProjects: allProjects ?? [],
  input,
  setInput,
  textareaRef,
});
```

And destructure `allProjects` in the function parameter:

```typescript
export function useChatComposerState({
  ...
  allProjects = [],
  ...
}: UseChatComposerStateOptions) {
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "C:\Users\zhenwang\source\Repos\claudecodeui2\claudecodeui" && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/hooks/useChatComposerState.ts
git commit -m "feat(mentions): thread allProjects through useChatComposerState"
```

---

### Task 3: Thread allProjects through ChatInterface

**Files:**
- Modify: `src/components/chat/types/types.ts`
- Modify: `src/components/chat/view/ChatInterface.tsx`

- [ ] **Step 1: Add `allProjects` to `ChatInterfaceProps`**

In `src/components/chat/types/types.ts`, find `ChatInterfaceProps` (line 96) and add:

```typescript
allProjects?: Project[];
```

Import `Project` if not already imported (it's already in scope via `app.ts`).

- [ ] **Step 2: Destructure and forward `allProjects` in `ChatInterface.tsx`**

In the destructured props (around line 25), add `allProjects = []`:

```typescript
function ChatInterface({
  selectedProject,
  selectedSession,
  ...
  allProjects = [],
}: ChatInterfaceProps) {
```

In the `useChatComposerState` call (around line 194), add:

```typescript
} = useChatComposerState({
  selectedProject,
  ...
  allProjects,
  ...
});
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "C:\Users\zhenwang\source\Repos\claudecodeui2\claudecodeui" && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/types/types.ts src/components/chat/view/ChatInterface.tsx
git commit -m "feat(mentions): add allProjects prop to ChatInterface"
```

---

### Task 4: Thread allProjects through MainContent and AppContent

**Files:**
- Modify: `src/components/main-content/types/types.ts`
- Modify: `src/components/main-content/view/MainContent.tsx`
- Modify: `src/components/app/AppContent.tsx`

- [ ] **Step 1: Add `allProjects` to `MainContentProps`**

In `src/components/main-content/types/types.ts`, find `MainContentProps` (line 36) and add:

```typescript
allProjects?: Project[];
```

`Project` is already imported at line 2.

- [ ] **Step 2: Destructure and forward `allProjects` in `MainContent.tsx`**

In the `MainContent` function destructuring (line 30), add `allProjects = []`:

```typescript
function MainContent({
  selectedProject,
  ...
  allProjects = [],
}: MainContentProps) {
```

In the `<ChatInterface ...>` JSX (around line 113), add:

```tsx
<ChatInterface
  ...
  allProjects={allProjects}
  ...
/>
```

- [ ] **Step 3: Pass `projects` as `allProjects` from `AppContent.tsx`**

In `AppContent.tsx`, add `projects` to the destructured return of `useProjectsState` (around line 30):

```typescript
const {
  projects,           // <-- add this
  selectedProject,
  selectedSession,
  ...
} = useProjectsState({...});
```

In the `<MainContent ...>` JSX (around line 174), add:

```tsx
<MainContent
  ...
  allProjects={projects}
  ...
/>
```

- [ ] **Step 4: Verify TypeScript compiles cleanly**

```bash
cd "C:\Users\zhenwang\source\Repos\claudecodeui2\claudecodeui" && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/components/main-content/types/types.ts src/components/main-content/view/MainContent.tsx src/components/app/AppContent.tsx
git commit -m "feat(mentions): thread allProjects from AppContent to ChatInterface"
```

---

### Task 5: Update ChatComposer dropdown UI

**Files:**
- Modify: `src/components/chat/view/subcomponents/ChatComposer.tsx`

- [ ] **Step 1: Add `Fragment` to React imports**

At the top of the file, ensure `Fragment` is imported:

```typescript
import React, { Fragment, ... } from 'react';
```

(Or use `<>` shorthand — but `Fragment` with key is needed here to add keys.)

- [ ] **Step 2: Replace the dropdown JSX block (lines 293-318)**

Replace with:

```tsx
{showFileDropdown && filteredFiles.length > 0 && (
  <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md">
    {filteredFiles.some((f) => f.type === 'project') && (
      <div className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Projects
      </div>
    )}
    {filteredFiles.map((item, index) => {
      const isProject = item.type === 'project';
      const prevItem = filteredFiles[index - 1];
      const showFilesHeader =
        !isProject && prevItem?.type === 'project';
      return (
        <Fragment key={item.path}>
          {showFilesHeader && (
            <div className="border-t border-border/30 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Files
            </div>
          )}
          <div
            className={`flex cursor-pointer touch-manipulation items-start gap-3 border-b border-border/30 px-4 py-3 last:border-b-0 ${
              index === selectedFileIndex
                ? 'bg-primary/8 text-primary'
                : 'text-foreground hover:bg-accent/50'
            }`}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectFile(item);
            }}
          >
            {isProject ? (
              <svg
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                />
              </svg>
            ) : (
              <svg
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{item.name}</span>
                {isProject && (
                  <span className="shrink-0 rounded px-1 py-0.5 text-xs bg-primary/10 text-primary">
                    Project
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {item.path}
              </div>
            </div>
          </div>
        </Fragment>
      );
    })}
  </div>
)}
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
cd "C:\Users\zhenwang\source\Repos\claudecodeui2\claudecodeui" && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/view/subcomponents/ChatComposer.tsx
git commit -m "feat(mentions): update dropdown UI with project icons and section headers"
```

---

### Task 6: Manual verification

- [ ] **Step 1: Start dev server**

```bash
cd "C:\Users\zhenwang\source\Repos\claudecodeui2\claudecodeui" && npm run dev
```

- [ ] **Step 2: Open the app and navigate to any project's chat**

- [ ] **Step 3: Type `@` in the chat input**

Expected:
- Dropdown appears
- All projects shown first under "Projects" header, each with folder icon and "Project" badge
- Current project's files shown below under "Files" header with file icon
- Keyboard navigation (arrow keys, Enter/Tab, Escape) works

- [ ] **Step 4: Type `@<partial-name>` to filter**

Expected: both projects and files are filtered by the query

- [ ] **Step 5: Click or press Enter on a project**

Expected: `project.fullPath` is inserted as text at cursor position, highlighted in blue like file mentions
