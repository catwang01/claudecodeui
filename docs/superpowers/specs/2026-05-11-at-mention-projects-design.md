# Design: Add Projects to @ Mention Dropdown

Date: 2026-05-11

## Overview

Extend the existing `@` file mention feature in the chat input to also surface project entries. When a user types `@`, projects appear first in the dropdown (before files), differentiated by a folder icon and "Project" badge.

## Design Decisions

1. **Insertion behavior**: Selecting a project inserts `project.fullPath` as plain text, identical to how file paths are inserted.
2. **Display order**: Projects appear before files in the dropdown.
3. **Visual differentiation**: Folder icon + "Project" badge for projects; file icon for files. Section headers "Projects" / "Files" appear when both types are present.
4. **Approach**: Extend `useFileMentions` directly (no new hooks or contexts).

## Section 1: Type Changes

`MentionableFile` in `useFileMentions.tsx` gains a `type` discriminator:

```typescript
export interface MentionableFile {
  name: string;
  path: string;
  type: 'file' | 'project';  // new
  relativePath?: string;
}
```

`UseFileMentionsOptions` gains `allProjects`:

```typescript
interface UseFileMentionsOptions {
  selectedProject: Project | null;
  allProjects: Project[];    // new
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
}
```

## Section 2: Filtering Logic

In the main `useEffect` that computes `filteredFiles`, project filtering is inserted before file filtering:

```typescript
// Projects: no hard cap, all matches shown
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

// Files: capped at 10 (unchanged limit)
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

`selectFile()` is unchanged since it only uses `item.path`.

## Section 3: UI Changes (ChatComposer.tsx)

The dropdown iterates `filteredFiles` and renders section headers + icons based on `item.type`:

- Section header "Projects" inserted before the first project item (when any exist)
- Section header "Files" inserted before the first file item (only when both types present)
- Folder SVG icon for `type === 'project'`, file SVG icon for `type === 'file'`
- "Project" badge (small pill) next to the project display name
- `item.path` truncated with `truncate` class to preserve row height

## Section 4: Data Pipeline (Prop Threading)

`projects` is available in `AppContent.tsx` (from `useProjectsState`). It is threaded down as `allProjects`:

| File | Change |
|------|--------|
| `AppContent.tsx` | Pass `allProjects={projects}` to `<MainContent>` |
| `main-content/types/types.ts` | Add `allProjects: Project[]` to `MainContentProps` |
| `MainContent.tsx` | Pass `allProjects={allProjects}` to `<ChatInterface>` |
| `chat/types/types.ts` | Add `allProjects: Project[]` to `ChatInterfaceProps` |
| `ChatInterface.tsx` | Pass `allProjects` to `useChatComposerState` |
| `useChatComposerState.ts` | Pass `allProjects` to `useFileMentions` |
| `useFileMentions.tsx` | Consume `allProjects` (core logic) |

`allProjects` defaults to `[]` at each boundary to prevent undefined propagation.

## Files Changed

1. `src/components/chat/hooks/useFileMentions.tsx` — type extension + filtering logic
2. `src/components/chat/view/subcomponents/ChatComposer.tsx` — dropdown UI with icons + headers
3. `src/components/chat/hooks/useChatComposerState.ts` — pass `allProjects` to `useFileMentions`
4. `src/components/chat/types/types.ts` — add `allProjects` to `ChatInterfaceProps`
5. `src/components/chat/view/ChatInterface.tsx` — receive + forward `allProjects`
6. `src/components/main-content/types/types.ts` — add `allProjects` to `MainContentProps`
7. `src/components/main-content/view/MainContent.tsx` — receive + forward `allProjects`
8. `src/components/app/AppContent.tsx` — pass `projects` as `allProjects`
