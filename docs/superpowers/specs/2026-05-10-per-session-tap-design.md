# Per-Session Claude-Tap Design

**Date:** 2026-05-10
**Status:** Approved
**Branch:** to be created from main

---

## Problem

Current claude-tap is a single global proxy: one `claude-tap` process handles all sessions. There is no way to:
- Enable tap only for specific sessions
- View traffic for a single session in isolation

## Goals

- Each session gets its own `claude-tap` proxy + viewer process pair
- User manually toggles tap on/off per session
- A tap index page (`/tap`) lists all active tap sessions and lets the user navigate to each viewer
- Tap process persists after session is closed; stops only when user manually stops it

---

## Architecture

### Backend: `server/tap.js`

Replace global singleton state with a `Map`:

```js
// Before
let tapProcess = null;
let tapPort = null;
let tapLivePort = null;

// After
const tapSessions = new Map();
// sessionId -> { process, proxyPort, viewerPort, sessionTitle, startedAt }
```

**New exports:**
- `startTapForSession(sessionId, sessionTitle, anthropicBaseUrl)` → `{ proxyPort, viewerPort }`
- `stopTapForSession(sessionId)` → void
- `getTapSession(sessionId)` → `{ proxyPort, viewerPort, ... } | null`
- `listTapSessions()` → array of session metadata

**Port allocation:** `findFreePorts(startPort, count)` scans from 18080 upward in steps of 2 (proxy port + viewer port per session). Maximum 10 concurrent tap sessions (ports 18080–18099).

**Backward compatibility:** Remove old global `startTapProxy`/`stopTapProxy`/`getTapProxyPort` exports. Remove the `tap_enabled` app config key. The global toggle in Settings is removed.

### Backend: `server/routes/settings.js`

Replace old global tap endpoints with session-scoped ones:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tap/sessions` | List all active tap sessions |
| GET | `/api/tap/sessions/:sessionId` | Get status for one session (200 if active, 404 if not) |
| POST | `/api/tap/sessions/:sessionId` | Start tap for a session |
| DELETE | `/api/tap/sessions/:sessionId` | Stop tap for a session |
| GET | `/api/tap/sessions/:sessionId/viewer/*` | Reverse-proxy to that session's live viewer |

`POST /api/tap/sessions/:sessionId` body: `{ sessionTitle?: string }`. Returns `{ proxyPort, viewerPort, startedAt }`.

The viewer proxy (`/api/tap/sessions/:sessionId/viewer/*`) works like the existing `tapViewerProxy` but reads the target port from `tapSessions.get(sessionId).viewerPort`. SSE URL rewriting must account for the new path prefix.

### Backend: `server/claude-sdk.js`

`mapCliOptionsToSDK(options, sessionId)` gains a `sessionId` parameter. If `getTapSession(sessionId)` returns a result, inject `ANTHROPIC_BASE_URL` into `extraArgs.settings.env`. Otherwise, do not inject anything.

The `sessionId` must be threaded from the WebSocket handler through to this function. It is already present in the query payload; it just needs to be passed down the call chain.

### Frontend: `ChatInputControls.tsx`

Replace the global radio-button tap toggle with a per-session button:

- Fetch tap status for this session: `GET /api/tap/sessions/:sessionId` (returns 200 with data if active, 404 if not)
- Button: tap icon, toggles on/off
- When tap is active: show an external-link icon that navigates to `/tap` (the index page), not directly to the viewer

### Frontend: New page `/tap`

Route: `src/pages/TapPage.tsx` (or equivalent in the existing router).

Fetches `GET /api/tap/sessions` on mount and polls every 5 seconds.

Displays a table:

```
┌─────────────────────────────────────────────────────────┐
│  Tap Sessions                                           │
├──────────────────┬─────────────┬───────────┬───────────┤
│ Session          │ Started     │ Status    │ Actions   │
├──────────────────┼─────────────┼───────────┼───────────┤
│ My session       │ 2 min ago   │ ● Running │ [View] [■]│
│ Debug run        │ 15 min ago  │ ● Running │ [View] [■]│
└──────────────────┴─────────────┴───────────┴───────────┘
```

- **View**: opens `/api/tap/sessions/:sessionId/viewer` in a new tab
- **Stop (■)**: calls `DELETE /api/tap/sessions/:sessionId`, removes from list
- **Status**: always "Running" (all entries in the map are running processes)

The `/tap` route is added to the existing router and linked from the Debug Settings Tab.

---

## Data Flow

```
1. User enables tap for session ABC
   → POST /api/tap/sessions/ABC { sessionTitle: "My session" }
   → findFreePorts(18080, 2) → [18080, 18081]
   → spawn claude-tap --proxy-port 18080 --viewer-port 18081 --upstream <anthropicBaseUrl>
   → tapSessions.set('ABC', { process, proxyPort: 18080, viewerPort: 18081, sessionTitle, startedAt })
   → Returns { proxyPort: 18080, viewerPort: 18081 }

2. Session ABC sends a query
   → mapCliOptionsToSDK(opts, 'ABC')
   → getTapSession('ABC') → { proxyPort: 18080 }
   → extraArgs.settings.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:18080'
   → SDK routes traffic through tap proxy

3. User opens /tap index page
   → GET /api/tap/sessions → [{ sessionId: 'ABC', sessionTitle: 'My session', proxyPort: 18080, viewerPort: 18081, startedAt }]
   → Renders table row for ABC

4. User clicks View for ABC
   → Opens /api/tap/sessions/ABC/viewer in new tab
   → Server proxies to http://127.0.0.1:18081

5. User clicks Stop for ABC
   → DELETE /api/tap/sessions/ABC
   → process.kill(), tapSessions.delete('ABC')
   → Row removed from index page
```

---

## Out of Scope

- Persistence across server restarts (tap sessions are in-memory only)
- Status differentiation (active vs. idle) — all running sessions show as "Running"
- Auto-stop when server process ends (SIGTERM handler calls `stopTapForSession` for all entries, same as current)

---

## Files Changed

| File | Change |
|------|--------|
| `server/tap.js` | Rewrite: singleton → Map-based manager |
| `server/routes/settings.js` | Replace global tap endpoints with session-scoped endpoints |
| `server/claude-sdk.js` | Thread `sessionId` into `mapCliOptionsToSDK`, conditional inject |
| `server/index.js` | Remove startup auto-start of global tap; update SIGTERM handler |
| `src/components/settings/view/tabs/ChatInputControls.tsx` | Per-session toggle button |
| `src/pages/TapPage.tsx` (new) | Tap session index page |
| Router config | Add `/tap` route |
| `src/components/settings/view/tabs/DebugSettingsTab.tsx` | Add link to `/tap` page |
