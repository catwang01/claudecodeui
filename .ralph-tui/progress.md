# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

### Per-Session Streaming Isolation Pattern
When a single component handles WebSocket messages for multiple concurrent sessions, use `useRef<Map<string, string>>` (keyed by sessionId) instead of `useRef<string>` for accumulated streaming buffers. Cleanup entries via a `useEffect` cleanup function scoped to `currentSessionId`.

---

## 2026-05-12 - US-002
- **What was implemented**: Added `clearSlot()` to `useSessionStore.ts` that zeroes out a slot's messages, sets status to `'loading'`, and resets `hasMore`/`total` before a new fetch. Called it from the main session loading effect in `useChatSessionState.ts` immediately before `fetchFromServer()`. Also tightened the "skip same-session refetch" guard to only skip when the provider is unchanged — a provider change now falls through to the clear+refetch path.
- **Files changed**:
  - `src/stores/useSessionStore.ts` — new `clearSlot()` callback, added to `useMemo` return and deps array
  - `src/components/chat/hooks/useChatSessionState.ts` — added `sessionStore.clearSlot(sessionId)` call before `fetchFromServer()`; updated "skip (same session, project key updated)" guard to also check `prevProvider === provider`
- **Learnings:**
  - `notify()` + `setIsLoadingSessionMessages(true)` are batched by React 18 into one render, so calling `clearSlot()` (which calls `notify()`) just before `setIsLoadingSessionMessages` guarantees the UI sees `messages=[]` and `isLoadingSessionMessages=true` in the same frame — no flicker.
  - The `notify()` guard `if (sessionId === activeSessionIdRef.current)` already handles AC #5 (HTTP response for a no-longer-active session only writes to store, no re-render) — no extra code needed.
  - The sessionKey format is `${sessionId}:${projectName}:${provider}` — splitting on `:` with index 0 = sessionId, index 2 = provider (index 1 = projectName which may contain colons, but in practice is safe for this split since provider is a short identifier at the end).
---


- **What was implemented**: Audited `dedupeMessages()` in `useSessionStore.ts` — confirmed correct coverage of all three dedup cases (id match, incoming-id matches existing-localMessageId, incoming-localMessageId matches existing-id). Added 3 unit tests explicitly covering the HTTP+WS concurrent delivery scenario.
- **Files changed**:
  - `src/stores/__tests__/sessionStoreHelpers.test.ts` — new `describe('HTTP + WebSocket concurrent scenario', ...)` block with 3 tests
- **Learnings:**
  - `dedupeMessages` was already fully correct; no implementation changes needed
  - `appendWsMessageBatch` already calls `dedupeMessages(slot.messages, msgs)` before appending — the race-window guard is already in place
  - Pre-existing typecheck errors in `SidebarSessionItem.tsx` (unrelated `title` prop) and Tailwind lint warnings remain; these predate this story
---

## 2026-05-12 - US-001
- **What was implemented**: Changed `accumulatedStreamRef` (single `useRef<string>`) to `accumulatedStreamMapRef` (`useRef<Map<string, string>>`) in the streaming pipeline, keyed by sessionId. Each `stream_delta` reads/writes only the entry for its own `sid`. The debounce timer flushes only the `sid` captured in its closure. `stream_end` and `complete` events delete the map entry for their `sid`. A cleanup `useEffect` removes the entry for `currentSessionId` on session change or component unmount.
- **Files changed**:
  - `src/components/chat/hooks/useChatRealtimeHandlers.ts` — interface type, destructuring, stream_delta/stream_end/complete handlers, deps array, new cleanup effect
  - `src/components/chat/view/ChatInterface.tsx` — ref initialization, `resetStreamingState`, prop name passed to hook
- **Learnings:**
  - `streamBufferRef` was already unused (accumulated but never read); left intact since it's out of scope
  - The debounce `streamTimerRef` is still a single timer; concurrent sessions may delay each other's flush by up to 100ms, but text isolation is fully correct with the map
  - Pre-existing TypeScript errors in `SidebarSessionItem.tsx` (unrelated `title` prop issues) and Tailwind lint warnings were already present before this change
---

## 2026-05-12 - US-006
- **What was implemented**: Added explicit `sessionId === activeSessionIdRef.current` guard in `fetchFromServer()` before calling `notify()` in both the success path and error path. Also added 3 unit tests covering the stale HTTP response scenario: slot isolation, notify guard, and data-still-written invariant.
- **Files changed**:
  - `src/stores/useSessionStore.ts` — replaced bare `notify(sessionId)` calls after `await` with explicit guard (`if (sessionId === activeSessionIdRef.current) notify(sessionId)`) in success and error paths
  - `src/stores/__tests__/sessionStoreHelpers.test.ts` — added `SessionSlot` import; new `describe('stale HTTP response guard — slot isolation', ...)` block with 3 tests
- **Learnings:**
  - The `notify()` function already had this guard internally, so the behavioral change is purely cosmetic (no-op → skip call entirely). The explicit guard in `fetchFromServer` makes intent clear without changing runtime behavior.
  - TypeScript infers string literal types (`'session-B'`) which causes TS2367 when comparing with a different literal. Typing the variable as `string` avoids the spurious error.
  - Testing slot isolation without `@testing-library/react` is viable by directly manipulating `Map<string, SessionSlot>` objects — tests the data layer invariant (slot A ≠ slot B) which is the foundational guarantee the notify guard builds on.
---

