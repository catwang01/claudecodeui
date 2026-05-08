# Session Delete Loading State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add loading indicator to session delete confirmation dialog to provide user feedback during deletion.

**Architecture:** State management in useSidebarController hook, UI rendering in SidebarModals component, state passing through Sidebar parent component. Uses existing async/await pattern with try/finally to ensure loading state cleanup.

**Tech Stack:** React, TypeScript, i18next for translations

---

## File Structure

**Modified Files:**
- `src/components/sidebar/hooks/useSidebarController.ts` - Add isDeletingSession state
- `src/components/sidebar/view/subcomponents/SidebarModals.tsx` - Update delete button UI
- `src/components/sidebar/view/Sidebar.tsx` - Pass isDeletingSession prop
- `src/i18n/locales/en/sidebar.json` - Add "deleting" translation
- `src/i18n/locales/de/sidebar.json` - Add "deleting" translation
- `src/i18n/locales/ja/sidebar.json` - Add "deleting" translation
- `src/i18n/locales/ko/sidebar.json` - Add "deleting" translation
- `src/i18n/locales/ru/sidebar.json` - Add "deleting" translation
- `src/i18n/locales/zh-CN/sidebar.json` - Add "deleting" translation

---

### Task 1: Add Translation Keys

**Files:**
- Modify: `src/i18n/locales/en/sidebar.json:59-71` (actions section)
- Modify: `src/i18n/locales/de/sidebar.json` (actions section)
- Modify: `src/i18n/locales/ja/sidebar.json` (actions section)
- Modify: `src/i18n/locales/ko/sidebar.json` (actions section)
- Modify: `src/i18n/locales/ru/sidebar.json` (actions section)
- Modify: `src/i18n/locales/zh-CN/sidebar.json` (actions section)

- [ ] **Step 1: Add English translation**

Read the current en/sidebar.json file to locate the actions section, then add the "deleting" key.

In `src/i18n/locales/en/sidebar.json`, add after line 66 (after "delete"):

```json
"deleting": "Deleting...",
```

- [ ] **Step 2: Add German translation**

In `src/i18n/locales/de/sidebar.json`, add to actions section:

```json
"deleting": "Wird gelöscht...",
```

- [ ] **Step 3: Add Japanese translation**

In `src/i18n/locales/ja/sidebar.json`, add to actions section:

```json
"deleting": "削除中...",
```

- [ ] **Step 4: Add Korean translation**

In `src/i18n/locales/ko/sidebar.json`, add to actions section:

```json
"deleting": "삭제 중...",
```

- [ ] **Step 5: Add Russian translation**

In `src/i18n/locales/ru/sidebar.json`, add to actions section:

```json
"deleting": "Удаление...",
```

- [ ] **Step 6: Add Chinese translation**

In `src/i18n/locales/zh-CN/sidebar.json`, add to actions section:

```json
"deleting": "删除中...",
```

- [ ] **Step 7: Commit translation changes**

```bash
git add src/i18n/locales/*/sidebar.json
git commit -m "feat(i18n): add deleting action translation for session delete loading"
```

---

### Task 2: Add Loading State to Controller Hook

**Files:**
- Modify: `src/components/sidebar/hooks/useSidebarController.ts:94-444`

- [ ] **Step 1: Add isDeletingSession state declaration**

In `useSidebarController.ts`, add state after line 111 (after sessionDeleteConfirmation state):

```typescript
const [isDeletingSession, setIsDeletingSession] = useState(false);
```

- [ ] **Step 2: Update confirmDeleteSession function to manage loading state**

Replace the `confirmDeleteSession` function (lines 412-444) with:

```typescript
const confirmDeleteSession = useCallback(async () => {
  if (!sessionDeleteConfirmation) {
    return;
  }

  const { projectName, sessionId, provider } = sessionDeleteConfirmation;
  
  // Set loading state BEFORE clearing confirmation to keep dialog open
  setIsDeletingSession(true);

  try {
    let response;
    if (provider === 'codex') {
      response = await api.deleteCodexSession(sessionId);
    } else if (provider === 'gemini') {
      response = await api.deleteGeminiSession(sessionId);
    } else {
      response = await api.deleteSession(projectName, sessionId);
    }

    if (response.ok) {
      onSessionDelete?.(sessionId);
      setSessionDeleteConfirmation(null); // Close dialog on success
    } else {
      const errorText = await response.text();
      logger.error('[Sidebar] Failed to delete session:', {
        status: response.status,
        error: errorText,
      });
      alert(t('messages.deleteSessionFailed'));
    }
  } catch (error) {
    logger.error('[Sidebar] Error deleting session:', error);
    alert(t('messages.deleteSessionError'));
  } finally {
    setIsDeletingSession(false);
  }
}, [onSessionDelete, sessionDeleteConfirmation, t]);
```

- [ ] **Step 3: Export isDeletingSession from hook return**

Find the return statement of the hook (around line 580) and add `isDeletingSession` to the returned object:

```typescript
return {
  // ... existing returns
  isDeletingSession,
  // ... rest of returns
};
```

- [ ] **Step 4: Verify the changes compile**

Run the TypeScript compiler to check for errors:

```powershell
npm run build
```

Expected: No TypeScript errors related to useSidebarController

- [ ] **Step 5: Commit controller changes**

```bash
git add src/components/sidebar/hooks/useSidebarController.ts
git commit -m "feat(sidebar): add isDeletingSession state for delete loading indicator"
```

---

### Task 3: Update Modal Component UI

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarModals.tsx:1-209`

- [ ] **Step 1: Add isDeletingSession prop to type definition**

In `SidebarModals.tsx`, update the `SidebarModalsProps` type (around line 15-36) to add:

```typescript
type SidebarModalsProps = {
  projects: Project[];
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  showNewProject: boolean;
  onCloseNewProject: () => void;
  onProjectCreated: () => void;
  deleteConfirmation: DeleteProjectConfirmation | null;
  onCancelDeleteProject: () => void;
  onConfirmDeleteProject: () => void;
  sessionDeleteConfirmation: SessionDeleteConfirmation | null;
  onCancelDeleteSession: () => void;
  onConfirmDeleteSession: () => void;
  isDeletingSession: boolean;  // Add this line
  showVersionModal: boolean;
  onCloseVersionModal: () => void;
  releaseInfo: ReleaseInfo | null;
  currentVersion: string;
  latestVersion: string | null;
  installMode: InstallMode;
  t: TFunction;
};
```

- [ ] **Step 2: Destructure isDeletingSession prop**

Update the function parameter destructuring (around line 51-72) to include `isDeletingSession`:

```typescript
export default function SidebarModals({
  projects,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  showNewProject,
  onCloseNewProject,
  onProjectCreated,
  deleteConfirmation,
  onCancelDeleteProject,
  onConfirmDeleteProject,
  sessionDeleteConfirmation,
  onCancelDeleteSession,
  onConfirmDeleteSession,
  isDeletingSession,  // Add this line
  showVersionModal,
  onCloseVersionModal,
  releaseInfo,
  currentVersion,
  latestVersion,
  installMode,
  t,
}: SidebarModalsProps) {
```

- [ ] **Step 3: Update cancel button in session delete modal**

Find the cancel button in the session delete confirmation modal (around line 182) and add `disabled` prop:

```tsx
<Button 
  variant="outline" 
  className="flex-1" 
  onClick={onCancelDeleteSession}
  disabled={isDeletingSession}
>
  {t('actions.cancel')}
</Button>
```

- [ ] **Step 4: Update delete button in session delete modal**

Replace the delete button (around line 185-192) with loading state:

```tsx
<Button
  variant="destructive"
  className="flex-1 bg-red-600 text-white hover:bg-red-700"
  onClick={onConfirmDeleteSession}
  disabled={isDeletingSession}
>
  {isDeletingSession ? (
    <>
      <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
      {t('actions.deleting')}
    </>
  ) : (
    <>
      <Trash2 className="mr-2 h-4 w-4" />
      {t('actions.delete')}
    </>
  )}
</Button>
```

- [ ] **Step 5: Verify the changes compile**

Run the TypeScript compiler:

```powershell
npm run build
```

Expected: No TypeScript errors related to SidebarModals

- [ ] **Step 6: Commit modal changes**

```bash
git add src/components/sidebar/view/subcomponents/SidebarModals.tsx
git commit -m "feat(sidebar): add loading state to session delete button"
```

---

### Task 4: Pass State Through Parent Component

**Files:**
- Modify: `src/components/sidebar/view/Sidebar.tsx:51-116`

- [ ] **Step 1: Destructure isDeletingSession from controller**

In `Sidebar.tsx`, find the useSidebarController destructuring (around line 51-116) and add `isDeletingSession`:

```typescript
const {
  isSidebarCollapsed,
  expandedProjects,
  editingProject,
  showNewProject,
  editingName,
  loadingSessions,
  initialSessionsLoaded,
  currentTime,
  isRefreshing,
  editingSession,
  editingSessionName,
  searchFilter,
  searchMode,
  setSearchMode,
  conversationResults,
  isSearching,
  searchProgress,
  clearConversationResults,
  deletingProjects,
  deleteConfirmation,
  sessionDeleteConfirmation,
  isDeletingSession,  // Add this line
  showVersionModal,
  filteredProjects,
  // ... rest of destructuring
} = useSidebarController({
  // ... args
});
```

- [ ] **Step 2: Pass isDeletingSession to SidebarModals**

Find the SidebarModals component usage (around line 190-211) and add the prop:

```tsx
<SidebarModals
  projects={projects}
  showSettings={showSettings}
  settingsInitialTab={settingsInitialTab}
  onCloseSettings={onCloseSettings}
  showNewProject={showNewProject}
  onCloseNewProject={() => setShowNewProject(false)}
  onProjectCreated={handleProjectCreated}
  deleteConfirmation={deleteConfirmation}
  onCancelDeleteProject={() => setDeleteConfirmation(null)}
  onConfirmDeleteProject={confirmDeleteProject}
  sessionDeleteConfirmation={sessionDeleteConfirmation}
  onCancelDeleteSession={() => setSessionDeleteConfirmation(null)}
  onConfirmDeleteSession={confirmDeleteSession}
  isDeletingSession={isDeletingSession}  // Add this line
  showVersionModal={showVersionModal}
  onCloseVersionModal={() => setShowVersionModal(false)}
  releaseInfo={releaseInfo}
  currentVersion={currentVersion}
  latestVersion={latestVersion}
  installMode={installMode}
  t={t}
/>
```

- [ ] **Step 3: Verify the changes compile**

Run the TypeScript compiler:

```powershell
npm run build
```

Expected: No TypeScript errors, successful build

- [ ] **Step 4: Commit parent component changes**

```bash
git add src/components/sidebar/view/Sidebar.tsx
git commit -m "feat(sidebar): wire up isDeletingSession state to modals"
```

---

### Task 5: Manual Testing

**Files:**
- Test: Session delete flow in UI

- [ ] **Step 1: Start development server**

```powershell
npm run dev
```

Expected: Server starts on http://localhost:5173 (or configured port)

- [ ] **Step 2: Test successful session deletion**

Manual steps:
1. Navigate to a project with sessions
2. Hover over a session and click the trash icon
3. Verify confirmation dialog appears
4. Click the "Delete" button
5. **Verify**: Button shows spinner and "Deleting..." text
6. **Verify**: Both buttons are disabled during deletion
7. **Verify**: Dialog closes automatically on success
8. **Verify**: Session is removed from the list

- [ ] **Step 3: Test session deletion from recents view**

Manual steps:
1. Switch to "Recent" view in search mode
2. Hover over a recent session and click the trash icon
3. Click "Delete" in the confirmation dialog
4. **Verify**: Loading state shows as expected
5. **Verify**: Session is removed after successful deletion

- [ ] **Step 4: Test multiple provider types**

Test deletion for each provider type if available:
- Claude session (regular)
- Codex session (if available)
- Gemini session (if available)

**Verify**: Loading state works correctly for all provider types

- [ ] **Step 5: Test rapid clicking**

Manual steps:
1. Open a session delete confirmation dialog
2. Rapidly click the "Delete" button multiple times
3. **Verify**: Button becomes disabled after first click
4. **Verify**: No duplicate API calls are made (check network tab)

- [ ] **Step 6: Test cancel button during deletion**

Manual steps:
1. Open session delete confirmation
2. Click "Delete" button
3. Immediately try to click "Cancel" button
4. **Verify**: Cancel button is disabled and non-clickable

- [ ] **Step 7: Verify translations**

Manual steps:
1. Test in English - verify "Deleting..." shows
2. Change language to German (if available) - verify "Wird gelöscht..." shows
3. Test other available languages

- [ ] **Step 8: Document test results**

Create a brief test summary noting:
- All scenarios tested
- Any issues found
- Browser(s) tested

---

### Task 6: Final Commit and Cleanup

- [ ] **Step 1: Verify all files are committed**

```powershell
git status
```

Expected: All working tree should be clean or only unrelated files

- [ ] **Step 2: Review commit history**

```powershell
git log --oneline -6
```

Expected: Should see 4 commits:
1. Translation keys
2. Controller state
3. Modal UI
4. Parent component wiring

- [ ] **Step 3: Create summary commit message if needed**

If all commits look good, the feature is complete. No summary commit needed.

---

## Implementation Complete

After completing all tasks above:
- Session delete confirmation dialog shows loading state
- Buttons are disabled during deletion
- Loading indicator uses spinner and "Deleting..." text
- Error handling maintains button state for retry
- All translations are in place
- Manual testing confirms functionality

**Next Steps:** Consider similar improvements for project deletion (out of scope for this plan).
