# Token Usage Per-Message Display Implementation Plan

> **Status:** Implemented (2026-05-18)

**Goal:** Show per-message token breakdown (input / output / cache read / cache creation) in the footer of each Claude assistant message.

**Architecture:** Token usage from `raw.message.usage` in JSONL is attached to normalized messages, aggregated per turn in `fetchHistory()`, passed through REST API unchanged, and rendered in the message footer with a hover tooltip.

**Tech Stack:** Node.js (backend adapter), TypeScript + React (frontend)

---

## File Map

| File | Change |
|------|--------|
| `server/providers/claude/adapter.js` | Attach `tokenUsage` to first text msg; mark `_entryOutputTokens`; turn-level aggregation in `fetchHistory()` |
| `server/providers/types.js` | Add `tokenUsage?` to NormalizedMessage JSDoc |
| `src/components/chat/types/types.ts` | Add `MessageTokenUsage` interface and `tokenUsage?` to `ChatMessage` |
| `src/stores/useSessionStore.ts` | Add `tokenUsage?` to `NormalizedMessage` interface |
| `src/components/chat/hooks/useChatMessages.ts` | Pass `tokenUsage` through during message conversion |
| `src/components/chat/view/subcomponents/MessageComponent.tsx` | Render token chips with Tooltip in footer |

---

### Task 1: Backend — attach tokenUsage to normalized assistant messages

- [x] Attach tokenUsage to first text assistant message in `normalizeMessage()`
- [x] Update JSDoc in `server/providers/types.js`

**Implementation note:** Originally attached to `messages[0]` but this failed when first block was thinking. Fixed to find first `kind=text && role=assistant` message.

---

### Task 2: Frontend types — add tokenUsage to ChatMessage

- [x] Add `MessageTokenUsage` interface to `types.ts`
- [x] Add `tokenUsage?` field to `ChatMessage`
- [x] Add `tokenUsage?` field to `NormalizedMessage` in `useSessionStore.ts`

---

### Task 3: Frontend display — render token chips in message footer

- [x] Add `formatTokenCount` helper
- [x] Render token chips with correct arrow directions (↑ input, ↓ output)
- [x] Add hover Tooltip showing detailed breakdown
- [x] Show total input in ↑ (new + cache_read + cache_creation)

---

### Task 4: Fix pass-through — tokenUsage not reaching frontend

- [x] `useChatMessages.ts` was not passing `tokenUsage` from `NormalizedMessage` to `ChatMessage`
- [x] Fixed by adding `tokenUsage: msg.tokenUsage as ChatMessage['tokenUsage']` to converted object

---

### Task 5: Turn-level output token aggregation

- [x] Mark `messages[0]._entryOutputTokens` in `normalizeMessage()` for each entry
- [x] Add post-processing in `fetchHistory()` to sum `_entryOutputTokens` per turn
- [x] Handles both old CLI (single multi-block entry) and new CLI (one entry per block)

**Rationale:** Newer Claude CLI records per-content-block `output_tokens` (e.g., text=1, tool_use=92). Without aggregation, the UI would show misleadingly low `↓ 1`.

---

## Commits (a7ec27f..f0320ee)

1. `c7abce1` feat(types): add MessageTokenUsage and tokenUsage field to ChatMessage
2. `e93f467` feat(chat): display per-message token usage in message footer
3. `719b157` fix(adapter): only attach tokenUsage to text assistant messages, not thinking/tool_use
4. `bf557ef` fix(chat): pass tokenUsage through normalizedToChatMessages to the UI
5. `3651fb5` fix(chat): swap arrow directions — ↑ input ↓ output
6. `85cc878` feat(chat): add hover tooltip showing token breakdown details
7. `07edf29` / `a7aab80` / `4ec6f3e` fix+revert: arrow direction corrections
8. `f0320ee` feat(chat): show total input tokens in ↑ (new + cache_read + cache_creation)

**Post-plan addition (uncommitted, working tree):** Turn-level output token aggregation in `adapter.js` — sums `_entryOutputTokens` across all blocks in the same assistant turn.
