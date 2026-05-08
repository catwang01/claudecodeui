# Session Delete Loading State Design

**Date:** 2026-05-08  
**Feature:** Add loading indicator to session delete confirmation dialog

## Overview

Currently, when a user deletes a session, they click the delete button in the confirmation dialog but receive no visual feedback until the operation completes. This design adds a loading state to the delete button to provide immediate feedback and prevent double-clicks.

## User Experience

When the user confirms a session deletion:
1. The delete button shows a spinner icon and changes text to "Deleting..."
2. Both the delete and cancel buttons are disabled
3. The dialog remains open until the operation completes
4. On success, the dialog closes automatically
5. On failure, an error alert is shown and the dialog remains open with buttons re-enabled

## Architecture

### Components Affected

1. **useSidebarController.ts** (State Management)
   - Manages the `isDeletingSession` boolean state
   - Sets state to true before API call, false after completion

2. **SidebarModals.tsx** (UI Component)
   - Receives `isDeletingSession` and `onConfirmDeleteSession` props
   - Renders loading state on delete button
   - Disables both buttons during deletion

3. **Sidebar.tsx** (Parent Component)
   - Passes `isDeletingSession` from controller to SidebarModals
   - No logic changes needed

### Data Flow

```
User clicks Delete
    |
    v
SidebarModals.onConfirmDeleteSession()
    |
    v
useSidebarController.confirmDeleteSession()
    |
    +-- Set isDeletingSession = true
    |
    +-- Call API (deleteSession/deleteCodexSession/deleteGeminiSession)
    |
    +-- Set isDeletingSession = false
    |
    +-- Close dialog (on success) OR show alert (on error)
```

## Implementation Details

### 1. useSidebarController.ts

Add state:
```typescript
const [isDeletingSession, setIsDeletingSession] = useState(false);
```

Modify `confirmDeleteSession`:
```typescript
const confirmDeleteSession = useCallback(async () => {
  if (!sessionDeleteConfirmation) return;

  const { projectName, sessionId, provider } = sessionDeleteConfirmation;
  
  // Set loading state BEFORE clearing confirmation (to keep dialog open)
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

Return `isDeletingSession` from the hook.

### 2. SidebarModals.tsx

Add prop:
```typescript
type SidebarModalsProps = {
  // ... existing props
  isDeletingSession: boolean;
};
```

Update delete button:
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

Update cancel button:
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

### 3. Sidebar.tsx

Pass the state to SidebarModals:
```tsx
<SidebarModals
  // ... existing props
  isDeletingSession={isDeletingSession}
  // ...
/>
```

## Error Handling

- Network errors: Caught in try/catch, alert shown, dialog remains open, buttons re-enabled
- API errors (4xx/5xx): Checked via response.ok, alert shown, dialog remains open, buttons re-enabled
- User can retry after seeing error by clicking delete again

## Translation Keys

Need to add to translation files:
- `actions.deleting` - "Deleting..." (shown on button during deletion)

Existing keys used:
- `actions.delete` - "Delete"
- `actions.cancel` - "Cancel"
- `messages.deleteSessionFailed` - Error message
- `messages.deleteSessionError` - Error message

## Edge Cases

1. **Multiple rapid clicks**: Prevented by disabling button during deletion
2. **Dialog close during deletion**: Cancel button disabled, only way to close is waiting for completion
3. **Session already deleted**: API will return error, user sees error message
4. **Network timeout**: Caught by try/catch, error alert shown

## Future Enhancements (Out of Scope)

- Toast notification instead of alert for better UX
- Optimistic UI update (remove from list immediately, rollback on error)
- Undo functionality
- Batch delete multiple sessions

## Testing Considerations

Manual testing scenarios:
1. Delete a Claude session - verify loading state and success
2. Delete a Codex session - verify correct API endpoint
3. Delete a Gemini session - verify correct API endpoint
4. Simulate network error - verify error handling and button re-enable
5. Rapidly click delete button - verify no double submission
6. Try clicking cancel during deletion - verify button is disabled

## Non-Goals

- This design does NOT add loading state to the delete button in the session list (the trash icon)
- This design does NOT add loading state to project deletion
- This design does NOT change the confirmation dialog appearance except for button states
