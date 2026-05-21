# Token Usage Per-Message Display

**Date**: 2026-05-18  
**Status**: Implemented

---

## Goal

Show per-message token breakdown (input / output / cache read / cache creation) on assistant messages, so users can understand Claude's token consumption at a glance.

---

## Architecture

Token usage data exists in JSONL as `raw.message.usage` on each assistant entry. The data is forwarded through the server normalization layer to the frontend, with turn-level aggregation to handle newer CLI per-block recording.

### Data Flow

```
JSONL: raw.message.usage
  → normalizeMessage() attaches tokenUsage to first text msg, marks _entryOutputTokens on messages[0]
  → fetchHistory() aggregates output tokens per assistant turn
  → REST GET /api/sessions/:id/messages
  → ChatMessage.tokenUsage in frontend
  → MessageComponent footer renders token breakdown with Tooltip
```

### CLI Version Compatibility

| CLI Version | JSONL Format | output_tokens meaning |
|---|---|---|
| Older | One entry per API call, content array has multiple blocks | Total for all blocks |
| Newer | One entry per content block | Per-block count |

The aggregation logic handles both: it sums `_entryOutputTokens` across all entries in a turn (between user messages). For old format (single entry → single `_entryOutputTokens`), the sum equals the original total. For new format (multiple entries), it correctly accumulates.

---

## Backend Changes

### 1. `server/providers/claude/adapter.js` — `normalizeMessage()`

After generating the `messages[]` array for an assistant entry, if `raw.message?.usage` exists:

```js
if (messages.length > 0 && raw.message?.usage) {
  const usage = raw.message.usage;
  const firstTextMsg = messages.find(m => m.kind === 'text' && m.role === 'assistant');
  if (firstTextMsg) {
    firstTextMsg.tokenUsage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    };
  }
  // Mark for turn-level aggregation
  messages[0]._entryOutputTokens = usage.output_tokens ?? 0;
}
```

Key decisions:
- Attach full `tokenUsage` to the first **text** assistant message (not `messages[0]` blindly, which could be a thinking block)
- Mark `_entryOutputTokens` on `messages[0]` regardless of kind — used only for aggregation, then deleted

### 2. `server/providers/claude/adapter.js` — `fetchHistory()` post-processing

After normalization and tool_result attachment, aggregate output tokens per turn:

```js
// Group consecutive assistant messages (separated by user/tool_result messages)
// Sum _entryOutputTokens within each group, assign to the text message
let turnStart = -1;
for (let i = 0; i <= normalized.length; i++) {
  const msg = i < normalized.length ? normalized[i] : null;
  const isAssistant = msg && msg.kind !== 'tool_result' && !(msg.kind === 'text' && msg.role === 'user');
  if (isAssistant && turnStart === -1) {
    turnStart = i;
  } else if (!isAssistant && turnStart !== -1) {
    const turn = normalized.slice(turnStart, i);
    let totalOutput = 0;
    for (const m of turn) {
      if (m._entryOutputTokens !== undefined) {
        totalOutput += m._entryOutputTokens;
        delete m._entryOutputTokens;
      }
    }
    const textMsg = turn.find(m => m.kind === 'text' && m.role === 'assistant' && m.tokenUsage);
    if (textMsg && totalOutput > 0) {
      textMsg.tokenUsage = { ...textMsg.tokenUsage, outputTokens: totalOutput };
    }
    turnStart = -1;
  }
}
```

### 3. `server/providers/types.js` — JSDoc update

Added `tokenUsage` to the `NormalizedMessage` typedef.

---

## Frontend Changes

### 4. `src/components/chat/types/types.ts`

```ts
export interface MessageTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// In ChatMessage:
tokenUsage?: MessageTokenUsage;
```

### 5. `src/stores/useSessionStore.ts`

Added `tokenUsage?` to `NormalizedMessage` interface for WebSocket pass-through.

### 6. `src/components/chat/hooks/useChatMessages.ts`

Pass `tokenUsage` through when converting `NormalizedMessage` → `ChatMessage`:

```ts
converted.push({
  type: 'assistant',
  content: text,
  timestamp: msg.timestamp,
  tokenUsage: msg.tokenUsage as ChatMessage['tokenUsage'],
});
```

### 7. `src/components/chat/view/subcomponents/MessageComponent.tsx`

Token chips in footer with hover Tooltip:

| Symbol | Meaning | Value |
|---|---|---|
| `↑` | Input (total context sent) | `inputTokens + cacheReadTokens + cacheCreationTokens` |
| `↓` | Output (agent response) | `outputTokens` (aggregated across turn) |
| `⚡` (green) | Cache read | `cacheReadTokens` (hidden if 0) |
| `+` (amber) | Cache write | `cacheCreationTokens` (hidden if 0) |

Tooltip on hover shows full breakdown including "new" (raw `inputTokens` = uncached portion).

Helper: `formatTokenCount(n) => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n)`

---

## What's NOT Changing

- The existing `/api/projects/:name/sessions/:id/token-usage` endpoint (context window pie) — untouched
- Real-time streaming token display — chips appear on page reload after response completes
- Other providers (cursor, codex, gemini) — no changes; `tokenUsage` is `undefined` for them

---

## Display Example

For an assistant message with usage `{ input: 3, output: 456, cache_read: 12340, cache_creation: 0 }`:

```
⏱ 2.3s  ·  ↑ 12.3k  ·  ↓ 456  ·  ⚡ 12.3k
```

Tooltip shows:
```
Input (total): 12,343
  · new: 3
Output: 456
Cache read: 12,340
```

(`+` chip hidden because `cacheCreationTokens === 0`)
