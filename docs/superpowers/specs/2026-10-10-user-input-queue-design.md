# User Input Queue Design

## Goal

Allow a user to prepare and queue follow-up inputs while an agent is still
running. After the current turn completes successfully, the application sends
the next queued input automatically and continues until the queue is empty.

The queue is scoped to a browser tab and a specific session. It supports
multiple sessions concurrently and preserves the complete composer state that
existed when each item was queued.

## User Experience

### Sending

- When the current session is idle, submitting the composer sends immediately,
  matching the existing behavior.
- When the current session is running, the composer remains enabled and the
  send action becomes "Add to queue".
- A successful queue operation clears the composer.
- A failed queue operation leaves the composer unchanged and displays an
  actionable error.

### Queue display

The current session's queue appears above the composer. Each queued item shows:

- Its FIFO position.
- A shortened text preview.
- Image and file attachment counts.
- A delete action.

Items appear in the conversation only when they are actually dispatched. This
prevents queued text from looking like a request the agent has already
received.

The list supports deletion but not editing or reordering in the first version.
An item already being dispatched cannot be deleted.

### Pause and resume

The queue pauses when:

- The current turn fails.
- The user aborts the current turn.
- The WebSocket disconnects before dispatch is confirmed.
- The stored session, provider, or project context is no longer valid.

A paused queue remains visible and persisted. The user can resume it explicitly.
Resume first confirms that the server reports the session as idle.

### Session switching

Queues are isolated by session. Switching away from a session does not pause
its queue. A successful completion event for an inactive session can dispatch
that session's next item in the background.

## Data Model

Introduce a queue-specific hook/store, separate from the message store:

```ts
interface QueuedInput {
  id: string;
  sessionKey: string;
  createdAt: number;
  status: 'queued' | 'dispatching';

  displayText: string;
  command: string;
  provider: SessionProvider;
  projectName: string;
  projectPath: string;

  model: string;
  permissionMode: string;
  thinkingMode: string;
  toolsSettings: Record<string, unknown>;

  uploadedImages: UploadedImage[];
  uploadedFiles: UploadedFile[];
  references: string[];
}

interface SessionInputQueue {
  paused: boolean;
  pauseReason?: 'failed' | 'aborted' | 'disconnected' | 'invalid-context';
  items: QueuedInput[];
}
```

The queue is serialized to `sessionStorage`. A schema version is stored with
the payload so incompatible future formats can be rejected explicitly instead
of being interpreted incorrectly.

Each session may contain at most 20 queued items.

## Composer Snapshot Preparation

Composer submission is split into two phases:

1. `prepareComposerInput()` validates input, resolves quotes and thinking-mode
   prefixes, uploads images and files, reads tool settings, and produces an
   immutable `QueuedInput`-compatible send snapshot.
2. The caller either dispatches the snapshot immediately or adds it to the
   current session queue.

Attachments are uploaded before an item enters the queue. Raw browser `File`
objects are never stored in `sessionStorage`. If any upload fails, the item is
not queued and the composer remains intact.

The snapshot includes the model, permission mode, thinking mode, provider,
tool settings, project path, attachments, and references selected at queue
time. Later UI changes do not mutate existing queue items.

## Session Keys and New Sessions

An existing session uses its real session ID as the queue key.

When the first turn creates a new session, queued follow-ups initially use the
same temporary session key used by the active chat view. On `session_created`,
the queue store atomically moves all items and pause state from the temporary
key to the real session ID.

Migration is idempotent. Repeated `session_created` events cannot duplicate
items.

## Dispatch Flow

Introduce `dispatchPreparedInput(snapshot)`, which contains the provider
command construction currently embedded in `handleSubmit`. Both immediate
sends and queued sends use this function.

For an immediate send:

1. Prepare the composer snapshot.
2. Add the optimistic user message.
3. Set loading and processing state.
4. Dispatch the prepared input.
5. Clear the composer.

For a queued send:

1. Prepare the composer snapshot.
2. Persist it with `status: 'queued'`.
3. Clear the composer.

For automatic dispatch:

1. Receive a successful `complete` for a specific session.
2. Confirm the completion is not aborted and has `exitCode === 0`.
3. Acquire the session's dispatch lock.
4. Mark the first item as `dispatching` and persist the queue.
5. Add its optimistic user message to that session's message slot.
6. Dispatch the stored provider command.
7. Remove the item only after the WebSocket transport accepts the payload.
8. Release the lock.

The next item is not sent until the resulting turn emits its own successful
`complete`.

The WebSocket `sendMessage` boundary must return whether it accepted the
payload for transmission. This is local transport acceptance, not a server
acknowledgement. If acceptance fails, the optimistic message is rolled back,
the item returns to `queued`, and the queue pauses as disconnected.

## Realtime Integration

`useChatRealtimeHandlers` remains responsible for interpreting provider
events. It calls queue-controller callbacks with the event's session ID:

- `onSessionCompleted(sessionId, result)`
- `onSessionFailed(sessionId, reason)`
- `onSessionCreated(temporaryId, realId)`
- `onWebSocketDisconnected()`
- `onSessionStatus(sessionId, running)`

Queue dispatch does not depend on the currently selected session. It uses the
stored snapshot and writes the optimistic message directly into the matching
session store slot.

On reconnect, the queue controller does not immediately send. It waits for the
existing `check-session-status` response and resumes only if the session is
idle and the queue is not paused for a failure or abort.

## Idempotency and Concurrency

The queue controller maintains one dispatch lock per session.

Before dispatch, it persists `status: 'dispatching'`. Duplicate completion
events, React effect reruns, and project refresh broadcasts therefore cannot
send the same queued item twice.

After a page refresh, a restored `dispatching` item is treated conservatively:
the controller checks server session status. If the session is running, it
waits. If the session is idle, it pauses the queue and asks the user to resume,
because the browser cannot prove whether the WebSocket send succeeded before
the refresh.

## Error Handling

- Queue limit reached: reject the new item and retain composer content.
- Attachment upload failure: do not enqueue; retain composer content.
- `sessionStorage` quota or serialization failure: do not enqueue; retain
  composer content.
- WebSocket disconnected: reject new dispatch, persist and pause the queue.
- Provider, project, or session mismatch: pause with `invalid-context`; never
  substitute the currently selected provider or project.
- Turn failure or abort: preserve all remaining queued items and pause. The
  request that already ran is not automatically retried.
- Deleting a session or project: remove its queue and uploaded temporary
  attachment references through the existing deletion lifecycle where
  available.

Errors must be visible to the user; the implementation must not silently drop,
skip, or rewrite queued inputs.

## Component Boundaries

### `useSessionInputQueue`

Owns queue state, sessionStorage serialization, FIFO operations, pause/resume,
temporary-ID migration, and dispatch locks.

### Composer preparation

Owns validation, uploads, quote composition, settings lookup, and immutable
snapshot creation.

### Prepared-input dispatcher

Owns provider-specific WebSocket message construction and optimistic message
insertion. It does not read mutable composer UI state.

### Queue UI

Renders the selected session's queue, pause reason, delete actions, and resume
action. It contains no dispatch logic.

### Realtime handler

Reports lifecycle events to the queue controller. It does not own queue state.

## Testing

### Unit tests

- FIFO enqueue and dequeue.
- Per-session isolation.
- SessionStorage restoration and schema validation.
- Maximum 20-item limit.
- Temporary-to-real session ID migration without duplication.
- Complete composer snapshot retention.
- Successful completion dispatches exactly one next item.
- Duplicate completion events do not double-send.
- Failure and abort pause without dropping items.
- Disconnect and reconnect status handling.
- Restored `dispatching` item pauses safely when status is ambiguous.
- Deleting queued items.
- Attachment upload failure and storage quota failure retain composer state.

### Component tests

- Running sessions keep the composer enabled.
- The send action changes to queue semantics while loading.
- Queue list shows text and attachment counts.
- Queued items can be deleted.
- Paused queues show a resume action and reason.

### Browser end-to-end tests

- Send a real first prompt, queue two follow-ups before completion, and verify
  they run in FIFO order.
- Verify a queued item does not appear as a chat message before dispatch.
- Switch to another session and verify the original session continues in the
  background.
- Abort a turn and verify the remaining queue pauses.
- Refresh with queued items and verify they restore from sessionStorage without
  duplicate dispatch.

## Out of Scope

- Cross-browser, cross-device, or server-restart persistence.
- Queue editing or drag-to-reorder.
- A global queue shared across sessions.
- More than one simultaneous turn within the same session.
- Server-side scheduling of queued inputs when the browser tab is closed.
