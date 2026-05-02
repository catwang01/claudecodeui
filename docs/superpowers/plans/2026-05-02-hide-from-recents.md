# Hide Session from Recents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users dismiss a session from the Recents sidebar; the session auto-reappears when it gets new activity.

**Architecture:** New SQLite table tracks hidden sessions with the lastActivity timestamp at hide-time. A shared `sessionDb` object in db.js handles all operations. Backend lazily auto-unhides on session listing. Frontend shows a hover × button and filters hidden sessions.

**Tech Stack:** better-sqlite3, Express.js, React, TypeScript

---

## File Map

| File | Change |
|------|--------|
| `server/database/init.sql` | Add `session_hidden_from_recents` table |
| `server/database/db.js` | Add `sessionDb`, `applyHiddenFromRecents`; update exports |
| `server/index.js` | Import `sessionDb`/`applyHiddenFromRecents`; add 2 routes; call `applyHiddenFromRecents` after `applyCustomSessionNames` |
| `server/projects.js` | Import + call `applyHiddenFromRecents` after each `applyCustomSessionNames` call |
| `server/routes/codex.js` | Import + call `applyHiddenFromRecents` after `applyCustomSessionNames` |
| `server/routes/cursor.js` | Import + call `applyHiddenFromRecents` after `applyCustomSessionNames` |
| `src/types/app.ts` | Add `hiddenFromRecents?: boolean` to `ProjectSession` |
| `src/components/sidebar/view/subcomponents/SidebarContent.tsx` | Filter hidden sessions; add hover × button + hide API call |

---

### Task 1: Add DB table

**Files:**
- Modify: `server/database/init.sql`

- [ ] **Step 1: Add table definition**

Append to `server/database/init.sql` after the `session_names` block (after line 92):

```sql

-- Session metadata (hidden from recents, etc.)
CREATE TABLE IF NOT EXISTS session_hidden_from_recents (
  session_id       TEXT NOT NULL,
  provider         TEXT NOT NULL DEFAULT 'claude',
  last_activity_at TEXT NOT NULL,
  hidden_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_session_hidden_lookup ON session_hidden_from_recents(session_id, provider);
```

- [ ] **Step 2: Verify SQL syntax**

```bash
cd /Users/tanhuan/claudecodeui
sqlite3 /tmp/test_schema.db < server/database/init.sql && echo "SQL OK"
```
Expected: `SQL OK`

---

### Task 2: Add sessionDb to db.js

**Files:**
- Modify: `server/database/db.js`

- [ ] **Step 1: Add `sessionDb` object and `applyHiddenFromRecents` function**

Insert after the closing `};` of `sessionNamesDb` (after line 555), before the `applyCustomSessionNames` function:

```js
// Generic session metadata DB (hidden from recents, extendable)
const sessionDb = {
  hideFromRecents: (sessionId, provider, lastActivityAt) => {
    db.prepare(`
      INSERT INTO session_hidden_from_recents (session_id, provider, last_activity_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider)
      DO UPDATE SET last_activity_at = excluded.last_activity_at, hidden_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider, lastActivityAt);
  },

  unhideFromRecents: (sessionId, provider) => {
    db.prepare(
      'DELETE FROM session_hidden_from_recents WHERE session_id = ? AND provider = ?'
    ).run(sessionId, provider);
  },

  // Returns Map<sessionId, lastActivityAt>
  getHiddenMap: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, last_activity_at FROM session_hidden_from_recents
       WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.last_activity_at]));
  },
};

// Apply hidden-from-recents flags; auto-unhides sessions with new activity
function applyHiddenFromRecents(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const hiddenMap = sessionDb.getHiddenMap(ids, provider);
    if (!hiddenMap.size) return;
    for (const session of sessions) {
      const lastActivityAtHide = hiddenMap.get(session.id);
      if (!lastActivityAtHide) continue;
      const currentActivity = session.lastActivity || session.createdAt || '';
      if (currentActivity && currentActivity > lastActivityAtHide) {
        // New activity since hide — auto-unhide lazily
        sessionDb.unhideFromRecents(session.id, provider);
      } else {
        session.hiddenFromRecents = true;
      }
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply hidden-from-recents for ${provider}:`, error.message);
  }
}
```

- [ ] **Step 2: Add to exports**

Replace the export block (lines 618–630):

```js
export {
  db,
  initializeDatabase,
  userDb,
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionNamesDb,
  sessionDb,
  applyCustomSessionNames,
  applyHiddenFromRecents,
  appConfigDb,
  githubTokensDb // Backward compatibility
};
```

---

### Task 3: Add API routes in index.js

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Update import on line 75**

```js
import { initializeDatabase, sessionNamesDb, sessionDb, applyCustomSessionNames, applyHiddenFromRecents } from './database/db.js';
```

- [ ] **Step 2: Apply hidden filter in GET /api/projects/:projectName/sessions (line 618)**

```js
app.get('/api/projects/:projectName/sessions', authenticateToken, async (req, res) => {
    try {
        const { limit = 5, offset = 0 } = req.query;
        const result = await getSessions(req.params.projectName, parseInt(limit), parseInt(offset));
        applyCustomSessionNames(result.sessions, 'claude');
        applyHiddenFromRecents(result.sessions, 'claude');
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
```

- [ ] **Step 3: Add hide/unhide routes after the rename route (after line 695)**

```js
// Hide session from recents
app.post('/api/sessions/:sessionId/hide', authenticateToken, (req, res) => {
    try {
        const { sessionId } = req.params;
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }
        const { provider, lastActivity } = req.body;
        if (!provider || !VALID_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
        }
        if (!lastActivity || typeof lastActivity !== 'string') {
            return res.status(400).json({ error: 'lastActivity is required' });
        }
        sessionDb.hideFromRecents(safeSessionId, provider, lastActivity);
        res.json({ success: true });
    } catch (error) {
        console.error(`[API] Error hiding session ${req.params.sessionId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Unhide session from recents
app.delete('/api/sessions/:sessionId/hide', authenticateToken, (req, res) => {
    try {
        const { sessionId } = req.params;
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }
        const { provider } = req.body;
        if (!provider || !VALID_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
        }
        sessionDb.unhideFromRecents(safeSessionId, provider);
        res.json({ success: true });
    } catch (error) {
        console.error(`[API] Error unhiding session ${req.params.sessionId}:`, error);
        res.status(500).json({ error: error.message });
    }
});
```

---

### Task 4: Apply hidden filter in projects.js and route files

**Files:**
- Modify: `server/projects.js`
- Modify: `server/routes/codex.js`
- Modify: `server/routes/cursor.js`

- [ ] **Step 1: Update import in projects.js (line 69)**

```js
import { applyCustomSessionNames, applyHiddenFromRecents } from './database/db.js';
```

- [ ] **Step 2: Call applyHiddenFromRecents after each applyCustomSessionNames in projects.js**

At lines 458, 462, 466, 470 (and 539, 542, 545), add the corresponding `applyHiddenFromRecents` call immediately after each `applyCustomSessionNames`:

```js
applyCustomSessionNames(project.sessions, 'claude');
applyHiddenFromRecents(project.sessions, 'claude');

// ...
applyCustomSessionNames(project.cursorSessions, 'cursor');
applyHiddenFromRecents(project.cursorSessions, 'cursor');

// ...
applyCustomSessionNames(project.codexSessions, 'codex');
applyHiddenFromRecents(project.codexSessions, 'codex');

// ...
applyCustomSessionNames(project.geminiSessions, 'gemini');
applyHiddenFromRecents(project.geminiSessions, 'gemini');
```

- [ ] **Step 3: Update import in codex.js**

```js
import { applyCustomSessionNames, sessionNamesDb, applyHiddenFromRecents } from '../database/db.js';
```

Add after `applyCustomSessionNames(sessions, 'codex');`:
```js
applyHiddenFromRecents(sessions, 'codex');
```

- [ ] **Step 4: Update import in cursor.js**

```js
import { applyCustomSessionNames, applyHiddenFromRecents } from '../database/db.js';
```

Add after `applyCustomSessionNames(sessions, 'cursor');`:
```js
applyHiddenFromRecents(sessions, 'cursor');
```

---

### Task 5: Update frontend types

**Files:**
- Modify: `src/types/app.ts`

- [ ] **Step 1: Add field to ProjectSession**

In `src/types/app.ts`, add `hiddenFromRecents?: boolean;` to the `ProjectSession` interface after `lastActivity`:

```ts
export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  hiddenFromRecents?: boolean;
  __provider?: SessionProvider;
  __projectName?: string;
  [key: string]: unknown;
}
```

---

### Task 6: Frontend — filter + hover × button

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`

- [ ] **Step 1: Add local hiddenSet state and hideSession function**

After `const sentinelRef = useRef<HTMLDivElement>(null);` (line 101), add:

```ts
const [hiddenSet, setHiddenSet] = useState<Set<string>>(new Set());

const hideSession = useCallback(async (sessionId: string, provider: string, lastActivity: string) => {
  const key = `${sessionId}:${provider}`;
  setHiddenSet(prev => new Set([...prev, key]));
  try {
    const token = localStorage.getItem('auth_token');
    await fetch(`/api/sessions/${sessionId}/hide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ provider, lastActivity }),
    });
  } catch {
    setHiddenSet(prev => { const next = new Set(prev); next.delete(key); return next; });
  }
}, []);
```

- [ ] **Step 2: Filter hidden sessions in recentSessions useMemo**

Update the `recentSessions` useMemo to exclude hidden sessions (both from DB flag and local optimistic set):

```ts
const recentSessions = useMemo(() => {
  if (searchMode !== 'recent') return [];
  const all: Array<{ session: ReturnType<typeof projectListProps.getProjectSessions>[number]; project: Project }> = [];
  for (const project of projectListProps.projects) {
    for (const session of projectListProps.getProjectSessions(project)) {
      all.push({ session, project });
    }
  }
  return all
    .filter(({ session }) => {
      if (session.hiddenFromRecents) return false;
      const provider = session.__provider || 'claude';
      if (hiddenSet.has(`${session.id}:${provider}`)) return false;
      return true;
    })
    .sort((a, b) => {
      const getTime = (s: typeof a.session) => {
        const date = s.lastActivity || s.createdAt || '';
        return date ? new Date(date).getTime() : 0;
      };
      return getTime(b.session) - getTime(a.session);
    });
}, [searchMode, projectListProps, hiddenSet]);
```

- [ ] **Step 3: Add hover × button to each session item**

In the session item render, wrap the existing `<div key={...} className="relative">` to add a group class and the × button. Replace the outer div:

```tsx
<div key={`${project.name}-${session.id}`} className="group relative">
  {/* Project color bookmark */}
  <div
    className="absolute left-2 top-1 bottom-1 w-[3px] rounded-full"
    style={{ background: color.dot }}
  />
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
    className="w-full rounded-md pr-2 py-2 pl-5 text-left transition-colors hover:bg-accent/50"
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
  <button
    className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex h-5 w-5 items-center justify-center rounded text-muted-foreground/50 hover:bg-accent hover:text-foreground transition-colors"
    onClick={(e) => { e.stopPropagation(); hideSession(session.id, session.__provider || 'claude', session.lastActivity || session.createdAt || ''); }}
    title="Remove from recents"
    type="button"
  >
    <X className="h-3 w-3" />
  </button>
</div>
```

- [ ] **Step 4: Add X to lucide imports**

In the import line at the top of the file, add `X` to the lucide-react imports:

```ts
import { Clock, Folder, MessageSquare, Search, X } from 'lucide-react';
```

- [ ] **Step 5: TypeScript check**

```bash
cd /Users/tanhuan/claudecodeui && npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
cd /Users/tanhuan/claudecodeui
git add server/database/init.sql server/database/db.js server/index.js server/projects.js server/routes/codex.js server/routes/cursor.js src/types/app.ts src/components/sidebar/view/subcomponents/SidebarContent.tsx
git commit -m "feat(recents): hide session from recents with auto-restore on new activity"
```
