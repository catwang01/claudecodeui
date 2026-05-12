# Background Session Permission Notification Design

**Date:** 2026-05-12
**Status:** Approved

## Problem

When Claude Code sends a permission request for a session that the user is not currently viewing, the request is silently filtered out. The user has no indication that a background session is waiting for their input, so Claude hangs indefinitely.

Current behavior (`useChatProviderState.ts:59-63`):
```ts
useEffect(() => {
  setPendingPermissionRequests((previous) =>
    previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
  );
}, [selectedSession?.id]);
```

## Design Decisions

| Decision | Choice |
|----------|--------|
| Notification style | Sidebar badge + Toast |
| Toast lifetime | 8s countdown auto-dismiss |
| Sidebar badge clears when | Permission dialog disappears (any reason) |

## Architecture

### Global Awaiting State

Add to `useSessionStore.ts`:

```ts
awaitingPermissionSessions: Map<string, { toolName: string; requestId: string }[]>
setAwaitingPermission: (sessionId: string, requests: { toolName: string; requestId: string }[]) => void
clearAwaitingPermission: (sessionId: string) => void
```

This map is the single source of truth for which sessions are currently waiting for user input. It is updated whenever `pendingPermissionRequests` changes for any session.

### Data Flow

1. Backend sends `permission_request` with `sessionId`
2. `useChatRealtimeHandlers.ts` receives it, adds to local `pendingPermissionRequests` (existing behavior), AND updates global `awaitingPermissionSessions` map
3. If `sessionId` != `selectedSession.id`, the Toast container sees a new entry and spawns a Toast
4. When permission is resolved (approved/denied/session ended), local `pendingPermissionRequests` goes to empty for that session -> `clearAwaitingPermission(sessionId)` is called
5. Sidebar reads the map and removes the badge; any open Toast for that session closes

## UI Components

### Sidebar Badge

On each session item in the recents list, check `awaitingPermissionSessions.has(session.id)`. If true, render a yellow "waiting" badge next to the session name.

Follows the same pattern as the existing read state indicator (`7f10991`).

### PermissionToastContainer

New component, rendered at the `AppContent` level, fixed to the bottom-right corner.

Subscribes to `awaitingPermissionSessions`. For each entry where `sessionId != selectedSession.id`, renders a `PermissionToast`.

```
PermissionToastContainer (fixed, bottom-right, z-index above chat)
  └── PermissionToast  (per waiting session)
        - Session name
        - Tool name
        - 8s countdown progress bar
        - [x] close button
        - Click anywhere -> setSelectedSession(session)
```

**Toast stacking:** Multiple toasts stack vertically (newest on top). Max 3 visible; if more, show a collapsed "...and N more" row.

**Toast close behavior:**
- Click `[x]` -> dismiss Toast only, sidebar badge remains
- Click body -> switch to session, Toast closes, sidebar badge remains until permission resolved
- Countdown expires -> Toast auto-dismisses, sidebar badge remains

### Trigger condition

Toast is only spawned when:
- A new entry appears in `awaitingPermissionSessions`
- AND the `sessionId` is not the currently selected session

Switching to a session that has a Toast -> that Toast closes immediately (since `sessionId` now equals `selectedSession.id`).

## Edge Cases

| Case | Behavior |
|------|----------|
| Permission request for current session | No Toast. Badge not shown (current session). Existing dialog shows as normal. |
| User switches to awaiting session while Toast is visible | Toast closes automatically. Badge clears when permission resolves. |
| Session is aborted/terminated | Backend clears permissions. Frontend receives update, `clearAwaitingPermission` called, badge and Toast disappear. |
| Multiple sessions waiting simultaneously | Toasts stack (up to 3 visible). Each sidebar item shows its own badge independently. |
| Permission request arrives with no sessionId | Falls back to existing behavior only; no Toast, no badge. |

## Files Changed

| File | Change |
|------|--------|
| `src/stores/useSessionStore.ts` | Add `awaitingPermissionSessions` Map + setters |
| `src/components/chat/hooks/useChatRealtimeHandlers.ts` | On `permission_request`: call `setAwaitingPermission`. On resolution: call `clearAwaitingPermission` |
| `src/components/sidebar/` (recents session item) | Read `awaitingPermissionSessions`, render badge |
| `src/components/common/PermissionToastContainer.tsx` | New file. Toast list + countdown logic |
| `src/components/common/PermissionToast.tsx` | New file. Single toast card component |
| `src/App.tsx` or layout root | Mount `<PermissionToastContainer />` |
