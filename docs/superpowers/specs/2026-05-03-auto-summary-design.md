# Auto Doc Generation — Design Spec

**Date:** 2026-05-03
**Status:** Implemented (critical scheduler issues remain)
**Renamed:** `auto-summary` → `auto-doc` across codebase on 2026-05-03

---

## Overview

Backend polling timer that periodically forks recent Claude sessions and sends an agent prompt to perform file-system work (e.g. organizing project documentation). No output is captured from the agent — results live entirely in the file system. The forked sessions are tracked in the database to avoid re-processing and to allow the frontend to identify/hide them.

---

## Architecture

### File: `server/auto-doc.js`

Single-responsibility module. Exports one function:

```js
startAutoDocTimer()  // called once at server startup
```

### Change to `server/index.js`

Called inside `server.listen()` callback alongside `setupProjectsWatcher()`:

```js
startAutoDocTimer();
```

---

## Timer Behavior

- **Interval:** 30 minutes (default, configurable via `AUTO_DOC_INTERVAL_MS` env var or `app_config.auto_doc_interval_ms`)
- **On startup:** First run fires immediately (no initial delay)
- **Scheduling:** Recursive `setTimeout` so interval changes take effect on the next cycle
- **Concurrency:** Serial — one session at a time within a batch; next batch waits for current batch to finish (`await fire()` before `scheduleNext()`)
- **⚠ No idempotency guard:** `startAutoDocTimer()` can be called multiple times (e.g. by dev-mode HMR restarts), spawning independent timer chains that fire concurrently. See Known Issues #13–14.
- **Error isolation:** A failure on one session logs a warning and moves on

---

## Session Selection

Each timer tick scans `~/.claude/projects/` JSONL files and collects sessions satisfying all of:

1. **Has sufficient content** — `messageCount >= 20` (configurable via `app_config.auto_doc_min_message_count`)
2. **Not currently active** — session ID not in `getActiveClaudeSDKSessions()`
3. **Not itself an auto-doc fork** — not present in `auto_doc_sessions` table
4. **Has enough new messages since last run** — `messageCount - last_message_count >= 20` (or no prior run)

Top 20 most-recently-active sessions are considered per batch.

Sessions from other providers (Cursor, Gemini, Codex) are skipped.

---

## Execution Flow (per session)

1. **Fork** the session via `forkSession(projectName, sessionId)` — creates a new JSONL with full history
2. **Mark** the fork in `auto_doc_sessions` table (so frontend can identify it)
3. **Run** the Claude agent via SDK `query()`:

```js
{
  resume: forkedSessionId,
  model,  // configurable, default 'claude-opus-4-6'
  cwd: session.cwd,
  maxTurns: 20,
  permissionMode: 'bypassPermissions',
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  tools: { type: 'preset', preset: 'claude_code' },
}
```

4. **Drain** the generator (output not captured — work is file-system side effects)
5. **Record state** via `sessionDb.setDocState()` to prevent re-processing

**Default Prompt:**
```
Based on this conversation, please organize and update the relevant project documentation.
```
(Configurable via `AUTO_DOC_PROMPT` env var or `app_config.auto_doc_prompt`)

---

## Database Tables

| Table | Purpose |
|---|---|
| `session_summary_state` | Tracks last processed message count per session to avoid redundant runs |
| `auto_doc_sessions` | Maps `forked_session_id → source_session_id` so the frontend can flag/hide forks |
| `app_config` | Stores `auto_doc_interval_ms`, `auto_doc_prompt`, `auto_doc_min_message_count`, `auto_doc_hide_sessions`, `auto_doc_model` |

Migration: On startup, `runMigrations()` automatically renames old `auto_summary_sessions` table and `auto_summary_*` config keys to `auto_doc_*`. Migration is wrapped in a SQLite transaction for atomicity.

---

## DB Helper Methods

| Method | Purpose |
|---|---|
| `sessionDb.setDocState()` | Upsert last-processed state for a session |
| `sessionDb.getDocStateMap()` | Batch lookup of processing state |
| `sessionDb.markAsAutoDocSession()` | Record a forked session as an auto-doc session |
| `sessionDb.getAutoDocSessionIds()` | Batch lookup of auto-doc session IDs |
| `sessionDb.getAllAutoDocSessionIds()` | Get all auto-doc session IDs for a provider |

---

## Frontend Integration

- `applyAutoDocFlag()` marks sessions with `isAutoDoc: true` based on `auto_doc_sessions` table
- Settings UI (`AutomationsSettingsTab`) allows configuring interval, prompt, min message count, model, and hide toggle
- When `auto_doc_hide_sessions` is enabled (default: true), sidebar filters out `isAutoDoc` sessions
- Sessions are filtered both server-side (via `preFilter` in `getSessions()`) and client-side (in `SidebarContent.tsx`)
- `searchConversations()` also skips auto-doc sessions when `auto_doc_hide_sessions` is enabled
- `SidebarContent.tsx` initializes `hideAutoDoc = true` to match the server default (avoids flicker)

---

## Sidebar Filtering Pipeline (detailed)

Two independent hiding mechanisms coexist. A session invisible in the sidebar could be hidden by **either** one.

### Mechanism 1: Auto-Doc Filter

Applied server-side in `getProjects()` (`server/projects.js:402-469`):

```
1. Read config: auto_doc_hide_sessions (null → true)
2. If hide enabled: getAllAutoDocSessionIds('claude') → Set<id>
3. Create preFilter = sessions.filter(s => !set.has(s.id))
4. getSessions(name, 5, 0, preFilter)  ← removes BEFORE pagination (line 448)
5. applyAutoDocFlag(sessions, 'claude') ← sets session.isAutoDoc = true (line 468)
6. filterHiddenAutoDocSessions(sessions) ← splices out isAutoDoc sessions (line 469)
```

Steps 4 and 6 are **redundant** — preFilter already removes the same IDs that filterHiddenAutoDocSessions would splice. Both exist for belt-and-suspenders safety.

The same preFilter logic is duplicated in `GET /api/projects/:projectName/sessions` (`server/index.js:615-632`).

### Mechanism 2: Hidden-From-Recents (user-initiated)

Applied via `applyHiddenFromRecents()` (`server/database/db.js:692-711`):

```
1. Batch-read session_hidden_from_recents table → Map<id, last_activity_at>
2. For each session:
   - If session.lastActivity > stored last_activity_at → auto-unhide (DELETE from table)
   - Else → set session.hiddenFromRecents = true
3. Frontend filters out hiddenFromRecents sessions from render
```

This mechanism is completely independent of auto-doc — it's triggered by the user clicking the "hide" button in the sidebar.

### Debugging Tip

If a session is invisible in the sidebar but has no auto-doc prompt in its history:
1. Check `session_hidden_from_recents` table — user may have manually hidden it
2. Check `auto_doc_sessions` table — session may have been incorrectly registered (e.g., after a failed/cancelled auto-doc run that still called `markAsAutoDocSession()` before the agent actually ran)
3. Verify `auth.db` is non-zero bytes — if 0, DB hasn't been initialized and neither filter should apply

---

## Settings API

- `GET /api/settings/auto-doc` — returns `{ intervalMs, prompt, minMessageCount, hideAutoDoc, model }`
- `PUT /api/settings/auto-doc` — accepts partial updates for any of the above fields
  - `minMessageCount`: validated between 1 and 10000
  - `intervalMs`: must be at least 60000 (1 minute)

---

## Key Design Decisions

- **`maxTurns: 20`** — Agent needs multiple turns to read files, plan, and write documentation. `maxTurns: 1` caused premature termination after tool calls (agent issued Glob calls but couldn't process results).
- **`bypassPermissions`** — Background agent needs to read/write files without user confirmation.
- **Server-side fork** (not SDK `forkSession`) — Ensures the forked session gets its own JSONL file visible to the frontend's session-filtered reader.
- **No output capture** — The value is in file-system side effects (docs written), not in the text response.
- **Default hide = true** — `auto_doc_hide_sessions` defaults to `true` when not set (null → true) to keep the sidebar clean. All null-handling paths (preFilter, `filterHiddenAutoDocSessions`, frontend initial state) are unified to this default.

---

## Known Issues (from 2026-05-03 code review)

### Critical

1. **`bypassPermissions` + user-editable prompt** — The background agent runs with unrestricted file system and Bash access. The prompt is freely editable via the settings API. A destructive prompt (e.g. `rm -rf`) would execute automatically at the next timer tick. Needs scoped permissions or explicit opt-in.

### Important — All fixed 2026-05-03

2. ~~**Concurrent batch execution** — `fire()` returns a Promise that is not awaited before `scheduleNext()`.~~ **Fixed:** `setTimeout(async () => { await fire(); scheduleNext(); }, intervalMs)`.
3. ~~**Null-handling inconsistency for `hideAutoDoc` default** — `filterHiddenAutoDocSessions()` treats null as "don't filter", but preFilter treats null as "hide".~~ **Fixed:** All paths now use `null → true`.
4. ~~**Frontend initial state mismatch** — `SidebarContent.tsx` initializes `hideAutoDoc = false` but server defaults to `true`.~~ **Fixed:** `useState(true)`.
5. ~~**DB helper naming inconsistency** — Helpers still called `markAsSummarySession`, `getSummarySessionIds`, etc.~~ **Fixed:** Renamed to `markAsAutoDocSession`, `getAutoDocSessionIds`, `getAllAutoDocSessionIds`, `setDocState`, `getDocStateMap`.
6. ~~**Hardcoded model** — `claude-opus-4-6` hardcoded with no config option.~~ **Fixed:** Configurable via `auto_doc_model` config key, `AUTO_DOC_MODEL` env var, and Settings UI.

### Minor — Mostly fixed 2026-05-03

7. ~~Dynamic `import('fs')` anti-pattern in `parseSessionsMeta()`.~~ **Fixed:** Static `import fsSync from 'fs'`.
8. No master enable/disable toggle for the entire auto-doc feature.
9. `auto_doc_sessions` table grows without bound; `getAllAutoDocSessionIds()` does full table scan.
10. ~~Data migration not wrapped in a transaction.~~ **Fixed:** `db.transaction()`.
11. ~~`getConfig()` called twice per batch cycle.~~ **Fixed:** Called once, passed as `config` arg.
12. ~~`minMessageCount` input has no upper-bound validation.~~ **Fixed:** `max={10000}` in frontend, server rejects `n > 10000`.

### Critical — Scheduler Concurrency (discovered 2026-05-03)

13. **`startAutoDocTimer()` not idempotent** — No module-level guard prevents duplicate calls. In dev mode, HMR hot-reloads call it again each restart, creating parallel timer chains. Each chain calls `fire()` immediately on creation and then schedules its own independent `setTimeout` loop. N restarts = N concurrent timer chains, all firing `runBatch()` at the same time.

14. **`runBatch()` has no concurrency lock** — When multiple `runBatch()` invocations run simultaneously (from parallel timer chains), they all call `selectCandidates()` before any fork's `setDocState()` has been written. All invocations see the same session as a valid candidate, each calling `forkSession()` independently. This creates N identical forks of the same parent session.

    **Fix:** Add `let _timerStarted = false` guard in `startAutoDocTimer()` and `let _batchRunning = false` mutex in `runBatch()`.

---

## Out of Scope

- Cursor, Gemini, Codex providers
- Per-session disable
- Streaming progress to frontend
