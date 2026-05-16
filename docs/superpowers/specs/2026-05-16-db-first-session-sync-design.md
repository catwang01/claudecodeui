# DB-First Session Sync — Design Spec

**Date**: 2026-05-16  
**Branch**: fix/websocket-reconnect-session-state  
**Goal**: Replace filesystem-scan architecture with DB-first session discovery, matching upstream (siteboon/claudecodeui) while preserving all local features.

---

## Problem

Currently `getProjects()` and `getSessions()` scan the filesystem on every API call. The watcher only broadcasts WebSocket events but never writes to the DB. The `sessions` table and `backfill.ts` exist but are disconnected from business logic. This means:

- Startup is slow (full directory scan every time)
- `backfill.ts` duplicates work the watcher should be doing
- The DB is out of sync until `backfill.ts` runs

---

## Goal State

After this migration:

1. **Startup**: session synchronizer scans all provider directories, upserts to `sessions` table, records `scan_state.last_scanned_at` (incremental on subsequent boots)
2. **Watcher**: file changes → DB upsert (via synchronizer) → debounced WS broadcast (reads from DB)
3. **API**: `getProjects()` / `getSessions()` read from `sessions` + `projects` tables; JSONL files are only accessed via `session_file_cache` for rich metadata

---

## Architecture

### New Modules

```
server/modules/
├── providers/
│   ├── services/
│   │   ├── session-synchronizer.service.ts   # Orchestrator: coordinates all provider synchronizers
│   │   └── sessions-watcher.service.ts       # chokidar watcher + WS broadcast (replaces setupProjectsWatcher)
│   └── list/
│       ├── claude/
│       │   └── claude-session-synchronizer.provider.ts
│       ├── cursor/
│       │   └── cursor-session-synchronizer.provider.ts
│       ├── codex/
│       │   └── codex-session-synchronizer.provider.ts
│       ├── gemini/
│       │   └── gemini-session-synchronizer.provider.ts
│       └── opencode/
│           └── opencode-session-synchronizer.provider.ts  # local addition (not in upstream)
└── projects/
    └── services/
        └── projects-with-sessions-fetch.service.ts  # DB-first getProjectsWithSessions()
```

### Modified Files

| File | Change |
|------|--------|
| `server/index.js` | Replace `setupProjectsWatcher()` with `initializeSessionsWatcher()` from new module; remove `backfill.ts` call |
| `server/projects.js` | `getProjects()` delegates to `getProjectsWithSessions()`; `getSessions()` queries `sessionsDb` then `getSessionFileMeta()` |
| `server/modules/database/schema.ts` | Fix `scan_state.last_scanned_at` → allow NULL (remove NOT NULL constraint) |

---

## Data Flow

### Startup

```
initializeSessionsWatcher()
  └─ sessionSynchronizerService.synchronizeSessions()
      ├─ scanStateDb.getLastScannedAt()         → null on first run, date on subsequent
      ├─ [for each provider]
      │   └─ synchronizer.synchronize(lastScanAt)
      │       ├─ find .jsonl files (since lastScanAt, or all if null)
      │       ├─ for each file:
      │       │   ├─ read first line → sessionId, projectPath
      │       │   ├─ read file stat → createdAt (birthtime), updatedAt (mtime)
      │       │   ├─ read custom name (history.jsonl for claude)
      │       │   └─ sessionsDb.createSession(...)   ← UPSERT
      │       └─ projectsDb.createProjectPath(projectPath)  ← ensures FK
      └─ scanStateDb.updateLastScannedAt(new Date())
```

### File Change (Watcher)

```
chokidar detects .jsonl add/change
  ├─ sessionSynchronizerService.synchronizeProviderFile(provider, filePath)
  │   └─ provider.synchronizer.synchronizeFile(filePath)
  │       ├─ read first line → sessionId, projectPath
  │       └─ sessionsDb.createSession(...)   ← UPSERT
  │
  └─ queuePendingWatcherUpdate(eventType, provider, sessionId)
      └─ [500ms debounce, 2s max wait]
          └─ flushPendingWatcherUpdate()
              ├─ getProjectsWithSessions({ skipSync: true })  ← DB read only
              └─ broadcast projects_updated to all connectedClients
```

### API Request (GET /api/projects)

```
getProjects()
  └─ getProjectsWithSessions()
      ├─ projectsDb.getAllProjects()              → project list from DB
      └─ for each project:
          ├─ sessionsDb.getSessionsByProjectPath(path)  → session IDs + jsonl_paths
          ├─ for each session:
          │   └─ getSessionFileMeta(jsonlPath)    → rich metadata via session_file_cache
          └─ applyXxx() chain:
              ├─ applyCustomSessionNames()
              ├─ applyHiddenFromRecents()
              ├─ applyAutoDocFlag() + applyLastAutoDocAt()
              ├─ filterHiddenAutoDocSessions()
              └─ applyReadState()
```

### API Request (GET /api/projects/:name/sessions)

```
getSessions(projectName, limit, offset)
  ├─ resolve projectPath from projectName
  ├─ sessionsDb.getSessionsByProjectPathPage(path, limit, offset)  → paginated session index
  ├─ for each session:
  │   └─ getSessionFileMeta(jsonlPath)    → rich metadata via session_file_cache
  └─ applyXxx() chain (same as above)
```

---

## Local Features Preservation

### Tables Preserved As-Is

| Table | Used For |
|-------|----------|
| `session_file_cache` | Rich metadata: `lastUserMessage`, `lastAssistantMessage`, `messageCount`, `cwd`, `lastActivity` |
| `session_hidden_from_recents` | User can hide sessions from recents view |
| `session_read_state` | Track whether user has viewed a session |
| `auto_doc_sessions` | Fork relationship for auto-doc feature (`isAutoDoc`, `lastAutoDocAt`) |

### Apply Functions (Migrated to TypeScript)

The six `applyXxx()` functions from `server/database/db.js` are extracted into typed helpers in `projects-with-sessions-fetch.service.ts`. Logic is unchanged.

### session_file_cache Strategy

`getSessionFileMeta(filePath)` continues to be called for each session to get rich metadata. The incremental-scan optimization (file size comparison) is kept intact. Only the **session index** (which sessions exist, which project they belong to) moves to the `sessions` table; the **content metadata** stays in `session_file_cache`.

### Provider-Specific Notes

- **opencode**: local addition not in upstream. Add `opencode-session-synchronizer.provider.ts` watching `~/.opencode/` (same pattern as others).
- **claude history.jsonl**: the session name lookup (Claude's `~/.claude/history.jsonl` `display` field) is implemented in `claude-session-synchronizer.provider.ts` only.

---

## Schema Fix

```sql
-- Before (wrong)
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY NOT NULL,
  last_scanned_at TIMESTAMP NOT NULL
);

-- After (correct — matches upstream)
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
```

This is an idempotent migration: if `scan_state` already has a row, the existing `last_scanned_at` value is preserved.

---

## What Is Removed

- `server/modules/database/backfill.ts` — replaced by `synchronizeSessions()` at startup (does the same thing, incrementally)
- The `setupProjectsWatcher()` function body in `server/index.js` — replaced by `initializeSessionsWatcher()` import
- Direct filesystem directory enumeration inside `getProjects()` — replaced by DB queries

---

## Testing Plan

1. **Unit tests** for each provider synchronizer: given a mock JSONL file, assert correct `sessionsDb.createSession()` call
2. **Unit tests** for `getProjectsWithSessions()`: mock `projectsDb` + `sessionsDb` + `getSessionFileMeta`, assert output shape
3. **Integration**: existing 75 tests must continue passing
4. **Manual smoke test**: start server, check projects load; add a new JSONL file, verify it appears within ~500ms

---

## Open Questions

None — all local features are accounted for and the approach is unambiguous.
