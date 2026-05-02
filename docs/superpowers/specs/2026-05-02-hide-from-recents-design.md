# Hide Session from Recents — Design Spec

**Date:** 2026-05-02  
**Status:** Approved

## Overview

Allow users to dismiss a session from the Recents sidebar list without physically deleting it. The session automatically re-appears if it receives new activity (i.e. `lastActivity` is updated past the value recorded at hide time).

## Behavior

- Each session in the Recents list shows a **×** dismiss button on hover.
- Clicking × hides the session from Recents immediately (optimistic UI).
- The hidden state is persisted to the backend SQLite database.
- **Auto-unhide**: when the session's current `lastActivity > last_activity_at` (the value captured when hidden), the session is automatically removed from the hidden table and reappears in Recents on the next load.
- There is no explicit "unhide" UI — only new activity triggers restoration.

## Database

**New table** in `server/database/init.sql`:

```sql
CREATE TABLE IF NOT EXISTS session_hidden_from_recents (
  session_id       TEXT NOT NULL,
  provider         TEXT NOT NULL DEFAULT 'claude',
  last_activity_at TEXT NOT NULL,   -- ISO timestamp at time of hiding
  hidden_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, provider)
);
```

**New DB object** in `server/database/db.js`: `sessionDb` (generic name, extendable for future session metadata).

Operations:
- `sessionDb.hideFromRecents(sessionId, provider, lastActivityAt)` — upsert row
- `sessionDb.unhideFromRecents(sessionId, provider)` — delete row
- `sessionDb.getHiddenMap()` — returns `Map<"sessionId:provider", lastActivityAt>` for O(1) lookup

## Backend API

New routes in `server/index.js`:

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/sessions/:sessionId/hide` | `{ provider, lastActivity }` | Hide session |
| `DELETE` | `/api/sessions/:sessionId/hide` | `{ provider }` | Unhide session (future use / manual) |

Both routes require `authenticateToken`.

**Auto-unhide on session listing**: in the function that assembles session data for the API response (near `applyCustomSessionNames`), join with the hidden map. For each session:
- If `hiddenMap` has an entry AND `session.lastActivity <= last_activity_at` → set `hiddenFromRecents: true`
- If `hiddenMap` has an entry AND `session.lastActivity > last_activity_at` → call `sessionDb.unhideFromRecents(...)` (lazy cleanup), leave `hiddenFromRecents` unset (session is visible)

## Frontend Types

`src/types/app.ts` — add to `ProjectSession`:
```typescript
hiddenFromRecents?: boolean;
```

## Frontend — SidebarContent.tsx

1. `recentSessions` useMemo: filter out sessions where `session.hiddenFromRecents === true`.
2. Each session item: add group-hover × button (absolutely positioned top-right).
3. On × click:
   - Optimistic update: add `sessionId:provider` to local `hiddenSet` state
   - Call `POST /api/sessions/:sessionId/hide`
   - On error: remove from `hiddenSet` (rollback)
4. Local `hiddenSet` (in-component state) ensures instant UI feedback without waiting for re-fetch.

## Files Changed

| File | Change |
|------|--------|
| `server/database/init.sql` | Add `session_hidden_from_recents` table |
| `server/database/db.js` | Add `sessionDb` object with 3 operations |
| `server/index.js` | Add 2 API routes; integrate hidden filter into session listing |
| `src/types/app.ts` | Add `hiddenFromRecents?: boolean` to `ProjectSession` |
| `src/components/sidebar/view/subcomponents/SidebarContent.tsx` | Filter hidden sessions; add × button + hide API call |
