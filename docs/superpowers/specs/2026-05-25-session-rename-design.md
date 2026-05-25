# Session Rename Feature Design

**Date:** 2026-05-25

## Summary

Add inline session rename capability in two places:
1. **Recent sessions sidebar** — add Edit button (hover) matching the existing Default variant behavior
2. **Chat interface title** — click the title text to enter inline edit mode

## Background

The backend is fully ready:
- `PUT /api/sessions/:sessionId/rename` endpoint exists in `server/index.js:673`
- `sessions.custom_name` column in SQLite; `sessionNamesDb.setName()` handles upsert
- `api.renameSession()` frontend helper exists in `src/utils/api.js`
- `useSidebarController.ts:updateSessionSummary()` already handles the API call + refresh

The gap is purely UI: the Recents variant in `SidebarSessionItem.tsx` has no edit button, and `MainContentTitle.tsx` displays the title read-only.

## Scope

**In scope:**
- Recents variant: show Edit2 icon on hover → trigger existing inline edit UI (input + check/cancel)
- Chat header: click title → inline `<input>` in place; Enter or blur saves; Esc cancels
- Optimistic UI update in chat header while awaiting refresh

**Out of scope:**
- Double-click to edit
- Rename via keyboard shortcut
- Rename from any other location

## Architecture

### 1. Recents Sidebar (`SidebarSessionItem.tsx`)

The `RecentsProps` variant already receives `editingSession`, `onStartEditingSession`, `onEditingSessionNameChange`, `onCancelEditingSession`, `onSaveEditingSession` but doesn't render the edit button.

**Change:** In the Recents action buttons block (where hide + delete live), add the Edit2 icon button matching the Default variant's implementation. The existing conditional at line ~317 that renders the edit input when `editingSession === session.id` already covers both variants.

The parent (`SidebarContent.tsx`) passes these props for the Recents list; verify they're wired up.

### 2. Chat Interface Title (`MainContentTitle.tsx`)

Add local state:
```typescript
const [isEditing, setIsEditing] = useState(false);
const [editValue, setEditValue] = useState('');
```

**Trigger:** wrap the title `<span>` in a clickable container; on click → `setIsEditing(true)`, `setEditValue(currentTitle)`.

**Edit UI:** replace the `<span>` with an `<input>` that:
- Matches title font/size styling
- Auto-focuses on mount (`autoFocus`)
- Shows a subtle bottom-border to signal editability
- On `Enter` / `blur` → call `api.renameSession(session.id, value.trim(), provider)` → call `onRenameSession()` callback → `setIsEditing(false)`
- On `Escape` → `setIsEditing(false)` (no save)
- Guard: if `value.trim() === ''` or `value === currentTitle`, skip API call

**New prop:** `onRenameSession: () => void` — signals parent to refresh sessions.

The parent (`ChatInterface.tsx` or equivalent) passes `onRenameSession` as a sessions refresh callback (the same `onRefresh` already used elsewhere).

## Data Flow (Chat Header)

```
User clicks title
  → isEditing = true, input renders
  → User types → editValue updates
  → Enter/blur → api.renameSession() → success → onRenameSession() → sessions refetch
                                     → failure → alert (same pattern as sidebar)
  → Esc → isEditing = false, no API call
```

## Error Handling

- Empty string: skip API call, revert
- Same name: skip API call, revert
- API error: show `alert()` (matches existing `updateSessionSummary` behavior), stay in edit mode

## Files Changed

| File | Change |
|------|--------|
| `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx` | Add Edit2 button to Recents variant action area |
| `src/components/sidebar/view/subcomponents/SidebarContent.tsx` | Verify/wire editing props to Recents list |
| `src/components/main-content/view/subcomponents/MainContentTitle.tsx` | Add click-to-edit inline rename |
| Parent of `MainContentTitle` | Pass `onRenameSession` refresh callback |
