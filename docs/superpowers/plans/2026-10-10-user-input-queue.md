# User Input Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users queue complete follow-up inputs per session while an agent is running, then dispatch them automatically in FIFO order after successful turns.

**Architecture:** Add a sessionStorage-backed queue store with immutable composer snapshots and one dispatch lock per session. Split composer preparation from provider command construction so immediate and queued sends share one path, then connect queue lifecycle callbacks to existing WebSocket completion, error, session-created, reconnect, and session-status events.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, browser `sessionStorage`, existing WebSocket context, existing Playwright browser tests.

## Global Constraints

- Queue persistence is limited to the current browser tab through `sessionStorage`.
- Queues are isolated by session and continue dispatching when their session is not selected.
- Each queued item snapshots text, quotes, images, files, references, model, permission mode, thinking mode, provider, project, and tool settings.
- Attachments upload before enqueue; raw browser `File` objects are never persisted.
- Each session supports at most 20 queued items.
- Queue order is FIFO.
- The first version supports listing and deletion, but not editing or reordering.
- Failed, aborted, disconnected, or invalid-context sessions pause their queue without dropping remaining items.
- Queued inputs appear in conversation history only when they are dispatched.
- A session may have at most one dispatching queue item.
- Do not add server-side queue persistence or new dependencies.

---

## File Structure

### New files

- `src/components/chat/queue/types.ts`
  - Shared queue, prepared-input, pause-reason, and storage-schema types.
- `src/components/chat/queue/sessionInputQueueStore.ts`
  - Pure sessionStorage-backed queue store, migration logic, and dispatch claims.
- `src/components/chat/queue/chatInputDispatch.ts`
  - Pure provider command builder and optimistic message builder.
- `src/components/chat/hooks/useSessionInputQueue.ts`
  - React adapter that subscribes to the queue store and coordinates dispatch.
- `src/components/chat/view/subcomponents/SessionInputQueuePanel.tsx`
  - Presentational queue list with delete and resume actions.
- `src/components/chat/queue/__tests__/sessionInputQueueStore.test.ts`
- `src/components/chat/queue/__tests__/chatInputDispatch.test.ts`
- `src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx`
- `src/components/chat/view/subcomponents/__tests__/SessionInputQueuePanel.test.tsx`
- `src/contexts/__tests__/WebSocketContext.test.ts`
- `tests/user-input-queue.spec.js`

### Modified files

- `src/contexts/WebSocketContext.tsx`
  - Return local transport acceptance from `sendMessage`.
- `src/components/chat/types/types.ts`
  - Update `sendMessage` signatures and shared chat props.
- `src/components/chat/hooks/useChatSessionState.ts`
  - Expose session-targeted optimistic insertion and rollback.
- `src/stores/useSessionStore.ts`
  - Add exact-message removal for failed local dispatch.
- `src/stores/__tests__/sessionStoreHelpers.test.ts`
  - Cover optimistic rollback.
- `src/components/chat/hooks/useChatComposerState.ts`
  - Create immutable prepared inputs and enqueue while loading.
- `src/components/chat/hooks/useChatRealtimeHandlers.ts`
  - Report queue lifecycle events by session ID.
- `src/components/chat/view/ChatInterface.tsx`
  - Own the queue hook and common dispatch callback.
- `src/components/chat/view/subcomponents/ChatComposer.tsx`
  - Keep the composer enabled while loading and render queue semantics.
- `src/i18n/locales/{de,en,ja,ko,ru,zh-CN}/chat.json`
  - Add queue labels, pause reasons, limits, and error copy.

---

### Task 1: Define the Queue Domain and Persistent Store

**Files:**
- Create: `src/components/chat/queue/types.ts`
- Create: `src/components/chat/queue/sessionInputQueueStore.ts`
- Create: `src/components/chat/queue/__tests__/sessionInputQueueStore.test.ts`

**Interfaces:**
- Produces:
  - `PreparedChatInput`
  - `QueuedInput`
  - `QueuePauseReason`
  - `SessionInputQueue`
  - `createSessionInputQueueStore(storage: Storage): SessionInputQueueStore`
  - `MAX_QUEUED_INPUTS_PER_SESSION = 20`
- Consumes: browser-compatible `Storage`.

- [ ] **Step 1: Write failing tests for FIFO state and the 20-item limit**

```ts
import { describe, expect, it } from 'vitest';
import {
  MAX_QUEUED_INPUTS_PER_SESSION,
  createSessionInputQueueStore,
} from '../sessionInputQueueStore';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

it('claims queued inputs in FIFO order', () => {
  const store = createSessionInputQueueStore(memoryStorage());
  store.enqueue('session-a', makePreparedInput('first'));
  store.enqueue('session-a', makePreparedInput('second'));

  expect(store.claimNext('session-a', 'complete-1')?.displayText).toBe('first');
  store.confirmDispatched('session-a', store.get('session-a').items[0].id);
  expect(store.claimNext('session-a', 'complete-2')?.displayText).toBe('second');
});

it('rejects item 21 without changing the queue', () => {
  const store = createSessionInputQueueStore(memoryStorage());
  for (let index = 0; index < MAX_QUEUED_INPUTS_PER_SESSION; index += 1) {
    expect(store.enqueue('session-a', makePreparedInput(String(index))).ok).toBe(true);
  }

  expect(store.enqueue('session-a', makePreparedInput('overflow'))).toEqual({
    ok: false,
    reason: 'limit',
  });
  expect(store.get('session-a').items).toHaveLength(20);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npm test -- src/components/chat/queue/__tests__/sessionInputQueueStore.test.ts
```

Expected: FAIL because the queue types and store do not exist.

- [ ] **Step 3: Define immutable queue types**

```ts
// src/components/chat/queue/types.ts
import type { SessionProvider } from '../../../types/app';

export type QueuePauseReason =
  | 'failed'
  | 'aborted'
  | 'disconnected'
  | 'invalid-context'
  | 'ambiguous-dispatch';

export interface UploadedQueueImage {
  name: string;
  path?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface UploadedQueueFile {
  name: string;
  path: string;
}

export interface PreparedChatInput {
  id: string;
  createdAt: number;
  displayText: string;
  command: string;
  provider: SessionProvider;
  projectName: string;
  projectPath: string;
  model: string;
  permissionMode: string;
  thinkingMode: string;
  toolsSettings: Record<string, unknown>;
  uploadedImages: UploadedQueueImage[];
  uploadedFiles: UploadedQueueFile[];
  references: string[];
  localMessageId: string;
}

export interface QueuedInput extends PreparedChatInput {
  sessionKey: string;
  status: 'queued' | 'dispatching';
}

export interface SessionInputQueue {
  paused: boolean;
  pauseReason?: QueuePauseReason;
  lastHandledCompletionId?: string;
  items: QueuedInput[];
}
```

- [ ] **Step 4: Implement the versioned persistent store**

Use one storage key, `chat_input_queues_v1`, and expose this exact interface:

```ts
export interface SessionInputQueueStore {
  subscribe(listener: () => void): () => void;
  get(sessionKey: string): SessionInputQueue;
  getAll(): Readonly<Record<string, SessionInputQueue>>;
  enqueue(sessionKey: string, input: PreparedChatInput):
    | { ok: true; item: QueuedInput }
    | { ok: false; reason: 'limit' | 'storage' };
  remove(sessionKey: string, itemId: string): boolean;
  claimNext(sessionKey: string, completionId: string): QueuedInput | null;
  confirmDispatched(sessionKey: string, itemId: string): boolean;
  releaseClaim(sessionKey: string, itemId: string): boolean;
  pause(sessionKey: string, reason: QueuePauseReason): void;
  resume(sessionKey: string): void;
  migrateSessionKey(from: string, to: string): void;
  clearSession(sessionKey: string): void;
  clearProject(projectName: string): void;
}
```

Implementation requirements:

```ts
export const MAX_QUEUED_INPUTS_PER_SESSION = 20;
const STORAGE_KEY = 'chat_input_queues_v1';
const EMPTY_QUEUE: SessionInputQueue = { paused: false, items: [] };
```

- Clone returned queues so callers cannot mutate store state.
- Persist before notifying subscribers.
- If `setItem` throws, restore the previous in-memory snapshot and return
  `{ ok: false, reason: 'storage' }`.
- `claimNext` atomically persists `lastHandledCompletionId`, rejects a repeated
  ID, and returns `null` when paused, empty, or an item is already
  `dispatching`.
- `migrateSessionKey` deduplicates by item ID and deletes the source key.
- `clearProject` removes every queue whose stored items belong to the deleted
  project.
- Invalid JSON or a payload whose `version !== 1` loads as an empty store and
  removes the invalid storage value.

- [ ] **Step 5: Add persistence, migration, pause, and corruption tests**

```ts
it('restores queues from the same storage instance', () => {
  const storage = memoryStorage();
  createSessionInputQueueStore(storage).enqueue('session-a', makePreparedInput('saved'));
  expect(createSessionInputQueueStore(storage).get('session-a').items[0].displayText).toBe('saved');
});

it('migrates a temporary queue without duplicating items', () => {
  const store = createSessionInputQueueStore(memoryStorage());
  store.enqueue('new-session-1', makePreparedInput('follow-up'));
  store.migrateSessionKey('new-session-1', 'real-session');
  store.migrateSessionKey('new-session-1', 'real-session');
  expect(store.get('real-session').items).toHaveLength(1);
  expect(store.get('new-session-1').items).toHaveLength(0);
});

it('does not claim from a paused queue', () => {
  const store = createSessionInputQueueStore(memoryStorage());
  store.enqueue('session-a', makePreparedInput('follow-up'));
  store.pause('session-a', 'failed');
  expect(store.claimNext('session-a', 'complete-1')).toBeNull();
});

it('keeps session queues isolated and clears deleted project queues', () => {
  const store = createSessionInputQueueStore(memoryStorage());
  store.enqueue('session-a', makePreparedInput('a', { projectName: 'project-a' }));
  store.enqueue('session-b', makePreparedInput('b', { projectName: 'project-b' }));
  store.clearProject('project-a');
  expect(store.get('session-a').items).toHaveLength(0);
  expect(store.get('session-b').items).toHaveLength(1);
});

it('does not claim a second item for the same completion id', () => {
  const store = createSessionInputQueueStore(memoryStorage());
  store.enqueue('session-a', makePreparedInput('first'));
  store.enqueue('session-a', makePreparedInput('second'));
  const first = store.claimNext('session-a', 'complete-1');
  store.confirmDispatched('session-a', first!.id);
  expect(store.claimNext('session-a', 'complete-1')).toBeNull();
  expect(store.get('session-a').items[0].displayText).toBe('second');
});
```

- [ ] **Step 6: Run queue store tests**

Run:

```powershell
npm test -- src/components/chat/queue/__tests__/sessionInputQueueStore.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/components/chat/queue/types.ts src/components/chat/queue/sessionInputQueueStore.ts src/components/chat/queue/__tests__/sessionInputQueueStore.test.ts
git commit -m "feat: add persistent session input queues"
```

---

### Task 2: Make WebSocket Dispatch Observable and Reversible

**Files:**
- Modify: `src/contexts/WebSocketContext.tsx`
- Create: `src/contexts/__tests__/WebSocketContext.test.ts`
- Modify: `src/components/chat/types/types.ts`
- Modify: `src/stores/useSessionStore.ts`
- Modify: `src/stores/__tests__/sessionStoreHelpers.test.ts`

**Interfaces:**
- Produces:
  - `sendMessage(message: unknown): boolean`
  - `removeMessage(sessionId: string, messageId: string): boolean`
- Consumes: existing WebSocket and session store.

- [ ] **Step 1: Write failing tests for transport acceptance**

Export a small pure helper from `WebSocketContext.tsx`:

```ts
export function sendWebSocketMessage(
  socket: Pick<WebSocket, 'readyState' | 'send'> | null,
  message: unknown,
): boolean;
```

Test:

```ts
it('returns true only when the open socket accepts the payload', () => {
  const send = vi.fn();
  expect(sendWebSocketMessage({ readyState: WebSocket.OPEN, send }, { type: 'ping' })).toBe(true);
  expect(send).toHaveBeenCalledWith('{"type":"ping"}');
  expect(sendWebSocketMessage({ readyState: WebSocket.CLOSED, send }, { type: 'ping' })).toBe(false);
  expect(sendWebSocketMessage(null, { type: 'ping' })).toBe(false);
});
```

- [ ] **Step 2: Write a failing optimistic rollback test**

Add a test to `sessionStoreHelpers.test.ts` through the real hook:

```ts
it('removes only the optimistic message with the requested id', () => {
  const { result } = renderHook(() => useSessionStore());
  act(() => {
    result.current.appendWsMessage('session-a', optimistic('local-1'));
    result.current.appendWsMessage('session-a', optimistic('local-2'));
  });

  act(() => {
    expect(result.current.removeMessage('session-a', 'local-1')).toBe(true);
  });

  expect(result.current.getMessages('session-a').map(message => message.id)).toEqual(['local-2']);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
npm test -- src/contexts/__tests__/WebSocketContext.test.ts src/stores/__tests__/sessionStoreHelpers.test.ts
```

Expected: FAIL because the helper and removal API do not exist.

- [ ] **Step 4: Implement boolean send acceptance**

```ts
export function sendWebSocketMessage(socket, message): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    logger.error('WebSocket send failed:', error);
    return false;
  }
}
```

Update `WebSocketContextType.sendMessage`, `ChatInterfaceProps.sendMessage`,
`UseChatComposerStateArgs.sendMessage`, and `UseChatSessionStateArgs.sendMessage`
from `void` to `boolean`. Existing callers may ignore the return value.

- [ ] **Step 5: Implement exact optimistic removal**

```ts
const removeMessage = useCallback((sessionId: string, messageId: string): boolean => {
  const slot = getSlot(sessionId);
  const next = slot.messages.filter(message => message.id !== messageId);
  if (next.length === slot.messages.length) return false;
  slot.messages = next;
  ssWrite(sessionId, next, Math.max(0, slot.total - 1));
  notify(sessionId);
  return true;
}, [getSlot, notify]);
```

Expose `removeMessage` from the store memo.

- [ ] **Step 6: Run targeted tests and typecheck**

```powershell
npm test -- src/contexts/__tests__/WebSocketContext.test.ts src/stores/__tests__/sessionStoreHelpers.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/contexts/WebSocketContext.tsx src/contexts/__tests__/WebSocketContext.test.ts src/components/chat/types/types.ts src/stores/useSessionStore.ts src/stores/__tests__/sessionStoreHelpers.test.ts
git commit -m "refactor: report chat transport acceptance"
```

---

### Task 3: Extract Immutable Prepared Inputs and Provider Commands

**Files:**
- Create: `src/components/chat/queue/chatInputDispatch.ts`
- Create: `src/components/chat/queue/__tests__/chatInputDispatch.test.ts`
- Modify: `src/components/chat/hooks/useChatComposerState.ts`

**Interfaces:**
- Consumes: `PreparedChatInput` from Task 1.
- Produces:
  - `createPreparedChatInput(args): PreparedChatInput`
  - `buildAgentCommand(input, sessionId): Record<string, unknown>`
  - `buildOptimisticUserMessage(input, sessionId): NormalizedMessage`

- [ ] **Step 1: Write failing provider command tests**

```ts
it('builds a Copilot command entirely from the queued snapshot', () => {
  const input = makePreparedInput({
    provider: 'copilot',
    command: 'queued prompt',
    model: 'gpt-5.5',
    permissionMode: 'plan',
    uploadedImages: [{ name: 'chart.png', data: 'base64', mimeType: 'image/png' }],
    uploadedFiles: [{ name: 'notes.txt', path: 'C:\\uploads\\notes.txt' }],
    references: ['C:\\repo\\src\\main.ts'],
  });

  expect(buildAgentCommand(input, 'session-a')).toEqual({
    type: 'copilot-command',
    command: 'queued prompt',
    sessionId: 'session-a',
    options: expect.objectContaining({
      sessionId: 'session-a',
      resume: true,
      cwd: input.projectPath,
      projectPath: input.projectPath,
      model: 'gpt-5.5',
      permissionMode: 'plan',
      images: input.uploadedImages,
      files: input.uploadedFiles,
      references: input.references,
    }),
  });
});
```

Add table-driven literal expectations for Claude, Cursor, Codex, and Gemini.
Verify the builder uses the supplied target session ID rather than a stored
temporary key.

- [ ] **Step 2: Write a failing optimistic message test**

```ts
it('creates a user message only when dispatch starts', () => {
  const message = buildOptimisticUserMessage(makePreparedInput({
    displayText: 'What changed?',
    localMessageId: 'local-1',
  }), 'session-a');

  expect(message).toMatchObject({
    id: 'local-1',
    sessionId: 'session-a',
    kind: 'text',
    role: 'user',
    content: 'What changed?',
  });
});

it('copies mutable composer values into an immutable snapshot', () => {
  const toolsSettings = { allowedTools: ['Read'] };
  const references = ['C:\\repo\\src\\main.ts'];
  const prepared = createPreparedChatInput(makeComposerArgs({ toolsSettings, references }));
  toolsSettings.allowedTools.push('Write');
  references.push('C:\\repo\\src\\other.ts');
  expect(prepared.toolsSettings).toEqual({ allowedTools: ['Read'] });
  expect(prepared.references).toEqual(['C:\\repo\\src\\main.ts']);
});
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
npm test -- src/components/chat/queue/__tests__/chatInputDispatch.test.ts
```

Expected: FAIL because the dispatch builders do not exist.

- [ ] **Step 4: Implement the pure builders**

`createPreparedChatInput` must accept already-uploaded attachment metadata and
copy every array/object so later composer mutations cannot change the snapshot:

```ts
export function createPreparedChatInput(args: CreatePreparedChatInputArgs): PreparedChatInput {
  return {
    id: args.id,
    createdAt: args.createdAt,
    displayText: args.displayText,
    command: args.command,
    provider: args.provider,
    projectName: args.projectName,
    projectPath: args.projectPath,
    model: args.model,
    permissionMode: args.permissionMode,
    thinkingMode: args.thinkingMode,
    toolsSettings: structuredClone(args.toolsSettings),
    uploadedImages: args.uploadedImages.map(image => ({ ...image })),
    uploadedFiles: args.uploadedFiles.map(file => ({ ...file })),
    references: [...args.references],
    localMessageId: args.localMessageId,
  };
}
```

`buildAgentCommand` must preserve the existing provider payload shapes from
`useChatComposerState.ts`. Do not introduce a generic server message.

- [ ] **Step 5: Refactor composer preparation without changing behavior**

In `useChatComposerState.ts`:

- Keep slash-command interception before queue preparation.
- Keep image and file upload behavior.
- Keep quote composition and thinking prefix behavior.
- Replace inline provider `sendMessage` branches with
  `createPreparedChatInput(...)` plus `buildAgentCommand(...)`.
- Continue immediate dispatch only in this task; queue branching arrives in
  Task 5.
- Check `sendMessage` return value. If false, add the existing visible error
  message and do not clear the composer.

- [ ] **Step 6: Run focused tests, existing composer-related tests, and typecheck**

```powershell
npm test -- src/components/chat/queue/__tests__/chatInputDispatch.test.ts src/components/chat/hooks/__tests__/useChatMessages.test.ts
npm run typecheck
```

Expected: PASS with unchanged immediate-send behavior.

- [ ] **Step 7: Commit**

```powershell
git add src/components/chat/queue/chatInputDispatch.ts src/components/chat/queue/__tests__/chatInputDispatch.test.ts src/components/chat/hooks/useChatComposerState.ts
git commit -m "refactor: prepare reusable chat input snapshots"
```

---

### Task 4: Implement the React Queue Controller

**Files:**
- Create: `src/components/chat/hooks/useSessionInputQueue.ts`
- Create: `src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx`
- Modify: `src/components/chat/hooks/useChatSessionState.ts`

**Interfaces:**
- Consumes:
  - `SessionInputQueueStore`
  - `sendMessage(message): boolean`
  - `sessionStore.appendWsMessage`
  - `sessionStore.removeMessage`
- Produces:

```ts
interface UseSessionInputQueueResult {
  getQueue(sessionKey: string | null): SessionInputQueue;
  enqueue(sessionKey: string, input: PreparedChatInput): QueueEnqueueResult;
  remove(sessionKey: string, itemId: string): boolean;
  resume(sessionKey: string): void;
  migrateSessionKey(from: string, to: string): void;
  handleComplete(
    sessionId: string,
    completionId: string,
    exitCode?: number,
    aborted?: boolean,
  ): void;
  handleFailure(sessionId: string, reason: 'failed' | 'aborted'): void;
  handleConnectionLost(): void;
  handleSessionStatus(sessionId: string, isProcessing: boolean): void;
}
```

- [ ] **Step 1: Write failing hook tests for exactly-once dispatch**

```tsx
it('dispatches one FIFO item and deduplicates its completion event', async () => {
  const sendMessage = vi.fn().mockReturnValue(true);
  const { result } = renderQueueHook({ sendMessage });

  act(() => {
    result.current.enqueue('session-a', makePreparedInput('first'));
    result.current.enqueue('session-a', makePreparedInput('second'));
    result.current.handleComplete('session-a', 'complete-1', 0, false);
    result.current.handleComplete('session-a', 'complete-1', 0, false);
  });

  await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  expect(result.current.getQueue('session-a').items.map(item => item.displayText))
    .toEqual(['second']);
});
```

- [ ] **Step 2: Write failing tests for rejection, pause, and background sessions**

```tsx
it('rolls back the optimistic message and pauses when transport rejects', async () => {
  const sendMessage = vi.fn().mockReturnValue(false);
  const removeMessage = vi.fn().mockReturnValue(true);
  const { result } = renderQueueHook({ sendMessage, removeMessage });

  act(() => {
    result.current.enqueue('inactive-session', makePreparedInput('background'));
    result.current.handleComplete('inactive-session', 'complete-1', 0, false);
  });

  await waitFor(() => {
    expect(result.current.getQueue('inactive-session')).toMatchObject({
      paused: true,
      pauseReason: 'disconnected',
    });
  });
  expect(removeMessage).toHaveBeenCalledWith('inactive-session', expect.any(String));
});

it('pauses without dispatching after abort', () => {
  const { result } = renderQueueHook();
  act(() => {
    result.current.enqueue('session-a', makePreparedInput('next'));
    result.current.handleFailure('session-a', 'aborted');
  });
  expect(result.current.getQueue('session-a').paused).toBe(true);
});
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
npm test -- src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx
```

Expected: FAIL because the hook does not exist.

- [ ] **Step 4: Expose session-targeted optimistic insertion**

Add to `useChatSessionState`:

```ts
const addMessageToSession = useCallback((
  sessionId: string,
  provider: SessionProvider,
  msg: ChatMessage,
) => {
  const normalized = chatMessageToNormalized(msg, sessionId, provider);
  if (normalized) sessionStore.appendWsMessage(sessionId, normalized);
}, [sessionStore]);
```

Return `addMessageToSession` alongside the existing active-session
`addMessage`.

- [ ] **Step 5: Implement queue dispatch**

The hook must:

1. Subscribe to the store and force a render on changes.
2. Ignore aborted completions and completions whose `exitCode !== 0`.
3. Call `claimNext(sessionId, completionId)`, which atomically rejects a
   completion whose normalized message ID equals `lastHandledCompletionId` and
   persists a new ID before claiming work.
4. Continue only when that call returns an item.
5. Validate the stored provider/project/session context before optimistic UI
   insertion. Pause with `invalid-context` instead of substituting current UI
   selections.
6. Build and append the optimistic message to the target session.
7. Call `sendMessage(buildAgentCommand(item, sessionId))`.
8. If accepted, call `confirmDispatched`.
9. If rejected, remove the optimistic message, call `releaseClaim`, and pause
   with `disconnected`.
10. Never dispatch a second item until another successful `complete` with a
    different event ID.
11. Operate solely on the event's session ID, not the active UI session.

- [ ] **Step 6: Implement conservative refresh and reconnect handling**

- On initial load, any persisted `dispatching` item remains dispatching until a
  session-status response arrives.
- `handleSessionStatus(sessionId, true)` waits.
- `handleSessionStatus(sessionId, false)` pauses an ambiguous dispatch with
  `ambiguous-dispatch`.
- A disconnected queue does not auto-resume. The explicit `resume` action
  clears pause state and sends `check-session-status`; dispatch happens only
  after an idle status callback.

- [ ] **Step 7: Run hook tests and typecheck**

```powershell
npm test -- src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/components/chat/hooks/useSessionInputQueue.ts src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx src/components/chat/hooks/useChatSessionState.ts
git commit -m "feat: dispatch queued inputs per session"
```

---

### Task 5: Connect Composer and Realtime Lifecycle Events

**Files:**
- Modify: `src/components/chat/hooks/useChatComposerState.ts`
- Modify: `src/components/chat/hooks/useChatRealtimeHandlers.ts`
- Modify: `src/components/chat/view/ChatInterface.tsx`
- Modify: `src/hooks/useProjectsState.ts`
- Test: `src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx`

**Interfaces:**
- Consumes all Task 4 queue-controller methods.
- Produces composer enqueue behavior and realtime queue lifecycle events.

- [ ] **Step 1: Add failing tests for lifecycle callback routing**

Extend the realtime handler test coverage with a small test harness:

```tsx
it('reports completion for the event session, including inactive sessions', () => {
  const onQueueComplete = vi.fn();
  renderRealtimeHarness({ activeSessionId: 'session-b', onQueueComplete });
  emit({ id: 'complete-1', kind: 'complete', sessionId: 'session-a', exitCode: 0 });
  expect(onQueueComplete).toHaveBeenCalledWith('session-a', 'complete-1', 0, false);
});

it('reports errors and aborted completions as queue pauses', () => {
  const onQueueFailure = vi.fn();
  const harness = renderRealtimeHarness({ onQueueFailure });
  harness.emit({ kind: 'error', sessionId: 'session-a' });
  harness.emit({ kind: 'complete', sessionId: 'session-b', aborted: true, exitCode: 130 });
  expect(onQueueFailure).toHaveBeenCalledWith('session-a', 'failed');
  expect(onQueueFailure).toHaveBeenCalledWith('session-b', 'aborted');
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
npm test -- src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx
```

Expected: FAIL because the realtime callbacks are not wired.

- [ ] **Step 3: Add queue callback arguments to `useChatRealtimeHandlers`**

Add:

```ts
onQueueComplete?: (
  sessionId: string,
  completionId: string,
  exitCode?: number,
  aborted?: boolean,
) => void;
onQueueFailure?: (sessionId: string, reason: 'failed' | 'aborted') => void;
onQueueSessionCreated?: (temporarySessionId: string, realSessionId: string) => void;
onQueueSessionStatus?: (sessionId: string, isProcessing: boolean) => void;
```

Rules:

- Call completion/failure callbacks even when the event session is inactive.
- Pass the normalized completion message `id` to the queue controller; this ID
  is the persisted duplicate-event guard.
- Preserve current selected-session UI state guards.
- Call status callback for both legacy `isProcessing` and structured status.
- On `session_created`, migrate from
  `pendingQueueSessionKeyRef.current` to `newSessionId`.

- [ ] **Step 4: Add queue support to composer submission**

Add arguments to `useChatComposerState`:

```ts
queueSessionKey: string | null;
enqueuePreparedInput: (sessionKey: string, input: PreparedChatInput) => QueueEnqueueResult;
dispatchPreparedInput: (sessionId: string, input: PreparedChatInput) => boolean;
```

Change the early guard from:

```ts
if (!hasContent || isLoading || !selectedProject || !isConnected) return;
```

to:

```ts
if (!hasContent || !selectedProject || !isConnected) return;
```

After uploads and snapshot creation:

```ts
if (isLoading) {
  const result = enqueuePreparedInput(queueSessionKey, preparedInput);
  if (!result.ok) {
    showQueueError(result.reason);
    return;
  }
  clearComposer();
  return;
}
```

Do not add an optimistic user message in the queue branch.

- [ ] **Step 5: Generate and migrate a stable temporary queue key**

In `ChatInterface.tsx`:

```ts
const pendingQueueSessionKeyRef = useRef<string | null>(null);
```

For a new session's first send, create exactly one
`new-session-${crypto.randomUUID()}` key and retain it until
`session_created`. Pass this key to the composer while loading. On migration,
clear the ref only after `migrateSessionKey` succeeds.

- [ ] **Step 6: Own the queue hook in `ChatInterface`**

Pass:

- `sessionStore`
- boolean-returning `sendMessage`
- `addMessageToSession`
- `onSessionProcessing`

Wire queue callbacks into `useChatRealtimeHandlers`.

On WebSocket disconnect, call `handleConnectionLost`. On reconnect, keep the
existing history refresh and status check; do not auto-resume failed or aborted
queues.

Build `validatePreparedInputContext` from `allProjects`. Match the stored
project by stable path first, then name; reject a provider mismatch for a known
session. A newly migrated session may be temporarily absent from a stale
project list only while its `session_created` mapping is retained locally.

- [ ] **Step 7: Run targeted tests and typecheck**

```powershell
npm test -- src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx src/components/chat/hooks/__tests__/useChatMessages.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Clear queues through existing deletion lifecycle**

Export a lazily-created browser singleton in
`sessionInputQueueStore.ts` while retaining the factory for tests:

```ts
export function getSessionInputQueueStore(): SessionInputQueueStore;
```

In `src/hooks/useProjectsState.ts`, after a confirmed server deletion:

- `handleSessionDelete(sessionId)` calls `clearSession(sessionId)`.
- `handleProjectDelete(projectName)` calls `clearProject(projectName)`.

Do not clear anything when the server deletion fails.

- [ ] **Step 9: Add deletion and invalid-context tests**

Cover:

- Deleted session queue is removed.
- Deleted project removes all of its session queues.
- Missing project or known provider mismatch pauses without calling
  `sendMessage`.
- A just-migrated new session is not falsely rejected before project refresh.

- [ ] **Step 10: Commit**

```powershell
git add src/components/chat/hooks/useChatComposerState.ts src/components/chat/hooks/useChatRealtimeHandlers.ts src/components/chat/view/ChatInterface.tsx src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx src/hooks/useProjectsState.ts src/components/chat/queue/sessionInputQueueStore.ts
git commit -m "feat: queue inputs while agents are running"
```

---

### Task 6: Add Queue Management UI and Localized Copy

**Files:**
- Create: `src/components/chat/view/subcomponents/SessionInputQueuePanel.tsx`
- Create: `src/components/chat/view/subcomponents/__tests__/SessionInputQueuePanel.test.tsx`
- Modify: `src/components/chat/view/subcomponents/ChatComposer.tsx`
- Modify: `src/components/chat/view/ChatInterface.tsx`
- Modify: `src/i18n/locales/de/chat.json`
- Modify: `src/i18n/locales/en/chat.json`
- Modify: `src/i18n/locales/ja/chat.json`
- Modify: `src/i18n/locales/ko/chat.json`
- Modify: `src/i18n/locales/ru/chat.json`
- Modify: `src/i18n/locales/zh-CN/chat.json`

**Interfaces:**
- Consumes selected session's `SessionInputQueue`.
- Produces list/delete/resume UI and queue-aware submit button copy.

- [ ] **Step 1: Write failing panel tests**

```tsx
it('renders FIFO positions and attachment counts', () => {
  render(
    <SessionInputQueuePanel
      queue={queueWith(
        item('First follow-up', { images: 1, files: 2 }),
        item('Second follow-up'),
      )}
      onDelete={vi.fn()}
      onResume={vi.fn()}
    />,
  );

  expect(screen.getByText('1')).toBeInTheDocument();
  expect(screen.getByText('First follow-up')).toBeInTheDocument();
  expect(screen.getByText(/1 image/i)).toBeInTheDocument();
  expect(screen.getByText(/2 files/i)).toBeInTheDocument();
});

it('disables deletion for the dispatching item and exposes resume when paused', () => {
  const onResume = vi.fn();
  render(<SessionInputQueuePanel queue={pausedDispatchingQueue()} onDelete={vi.fn()} onResume={onResume} />);
  expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /resume/i }));
  expect(onResume).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
npm test -- src/components/chat/view/subcomponents/__tests__/SessionInputQueuePanel.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the presentational panel**

Requirements:

- Return `null` for an empty, unpaused queue.
- Use stable item IDs as React keys.
- Truncate preview visually, not in stored data.
- Render image/file counts only when nonzero.
- Disable deletion for `status === 'dispatching'`.
- Render a localized pause reason and Resume button when paused.
- Do not call queue store methods directly; use props only.

- [ ] **Step 4: Keep the composer enabled while loading**

In `ChatComposer.tsx`:

```tsx
disabled={!input.trim() || !isConnected}
```

Add:

```ts
submitMode: 'send' | 'queue';
queue: SessionInputQueue;
onDeleteQueuedInput: (itemId: string) => void;
onResumeQueue: () => void;
```

Render `SessionInputQueuePanel` immediately above the form. Change the button
title and accessible label to localized "Add to queue" when `submitMode` is
`queue`; keep the send icon unless a queue-specific icon already exists in the
repository.

- [ ] **Step 5: Add localized strings in every chat locale**

Use this key shape consistently:

```json
{
  "inputQueue": {
    "add": "Add to queue",
    "title": "Queued inputs",
    "delete": "Remove queued input",
    "resume": "Resume queue",
    "paused": "Queue paused",
    "limitReached": "This session already has 20 queued inputs.",
    "storageFailed": "The input could not be saved to this tab.",
    "uploadFailed": "Attachments could not be prepared for the queue.",
    "imageCount": "{{count}} image",
    "imageCount_other": "{{count}} images",
    "fileCount": "{{count}} file",
    "fileCount_other": "{{count}} files",
    "pauseReasons": {
      "failed": "The previous turn failed.",
      "aborted": "The previous turn was stopped.",
      "disconnected": "The connection was interrupted.",
      "invalid-context": "The original session context is no longer available.",
      "ambiguous-dispatch": "Confirm before retrying after the page refresh."
    }
  }
}
```

Translate values for each locale; do not leave English placeholders in
non-English files.

- [ ] **Step 6: Run component tests and typecheck**

```powershell
npm test -- src/components/chat/view/subcomponents/__tests__/SessionInputQueuePanel.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/components/chat/view/subcomponents/SessionInputQueuePanel.tsx src/components/chat/view/subcomponents/__tests__/SessionInputQueuePanel.test.tsx src/components/chat/view/subcomponents/ChatComposer.tsx src/components/chat/view/ChatInterface.tsx src/i18n/locales/*/chat.json
git commit -m "feat: add chat input queue controls"
```

---

### Task 7: Validate End-to-End Queue Behavior

**Files:**
- Create: `tests/user-input-queue.spec.js`
- Modify only if a discovered queue bug requires it: files from Tasks 1-6.

**Interfaces:**
- Consumes the completed queue feature.
- Produces regression coverage for real browser behavior.

- [ ] **Step 1: Add deterministic Playwright queue behavior coverage**

The browser test must:

1. Open a known session.
2. Start a turn and hold its completion through the test WebSocket harness.
3. Enter two follow-ups while loading.
4. Assert both appear in the queue panel and not in chat history.
5. Switch to another session.
6. Complete the original session's first turn successfully.
7. Assert only the first queued input becomes an optimistic user message in the
   inactive original session.
8. Complete that turn and assert the second queued input dispatches.
9. Abort the second queued turn and assert remaining items pause.
10. Reload with a separate queued item and assert restoration from
    sessionStorage.
11. Reload with a persisted `dispatching` item, report the session idle, and
    assert the UI pauses instead of sending it again.

Use literal prompt markers:

```js
const FIRST = 'QUEUE_E2E_FIRST';
const SECOND = 'QUEUE_E2E_SECOND';
const THIRD = 'QUEUE_E2E_THIRD';
```

- [ ] **Step 2: Run the Playwright test and verify RED if integration is incomplete**

```powershell
npx playwright test tests/user-input-queue.spec.js --reporter=line
```

Expected before final integration fixes: a specific assertion fails at the
first missing queue behavior, not a setup or selector error.

- [ ] **Step 3: Fix only behavior exposed by the browser test**

Likely allowed fixes:

- Incorrect queue key migration.
- Active-session-only completion routing.
- Optimistic message inserted before dispatch.
- Duplicate dispatch after repeated completion.
- Missing pause state after abort or disconnect.

Do not expand scope to editing, reordering, global queues, or server
persistence.

- [ ] **Step 4: Run focused queue tests**

```powershell
npm test -- src/components/chat/queue/__tests__/sessionInputQueueStore.test.ts src/components/chat/queue/__tests__/chatInputDispatch.test.ts src/components/chat/hooks/__tests__/useSessionInputQueue.test.tsx src/components/chat/view/subcomponents/__tests__/SessionInputQueuePanel.test.tsx src/contexts/__tests__/WebSocketContext.test.ts src/stores/__tests__/sessionStoreHelpers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full validation**

```powershell
npm test
npm run typecheck
npx playwright test tests/user-input-queue.spec.js --reporter=line
git --no-pager diff --check
```

Expected:

- All Vitest tests pass.
- Client and server TypeScript checks pass.
- Queue Playwright test passes.
- No whitespace errors.

- [ ] **Step 6: Perform a real-provider smoke test**

Use an isolated home and application database so the active Copilot CLI
session does not trigger unrelated file watcher work:

1. Copy the real Copilot top-level authentication/config files and a consistent
   SQLite backup of `session-store.db` into a session-state test home.
2. Do not copy the active real `session-state` directory.
3. Start the dev server in tmux on an unused port.
4. Send a unique first Copilot prompt through the UI.
5. Queue two unique follow-ups before the first answer completes.
6. Verify the sidebar/session stays responsive and the follow-ups execute in
   FIFO order without manual refresh.
7. Capture a screenshot in the session artifact directory.
8. Stop the tmux service and remove only the named test home and test database.

- [ ] **Step 7: Commit**

```powershell
git add tests/user-input-queue.spec.js
git add src/components/chat src/contexts/WebSocketContext.tsx src/stores/useSessionStore.ts src/i18n/locales
git commit -m "test: cover queued chat inputs end to end"
```

---

## Final Review Checklist

- [ ] Queues survive refresh in the same browser tab.
- [ ] Queues do not survive tab closure by design.
- [ ] Every queue item uses its enqueue-time provider, model, permission mode,
      thinking mode, tool settings, project, attachments, and references.
- [ ] Switching sessions does not block background queue dispatch.
- [ ] Queued inputs are invisible in chat history until dispatch.
- [ ] Successful turns dispatch exactly one next item.
- [ ] Failure, abort, disconnect, and invalid context pause without dropping
      remaining items.
- [ ] Duplicate completion and status events cannot double-send.
- [ ] Temporary session migration is idempotent.
- [ ] Attachment and sessionStorage failures preserve composer contents.
- [ ] Queue list supports deletion only; no editing or reordering was added.
- [ ] Full Vitest, typecheck, Playwright, and real-provider smoke verification
      pass before completion is claimed.
