/**
 * Shared localid mapping utilities.
 *
 * Decouples localId resolution from the chokidar file watcher so that
 * adapter.js (fetchHistory) can resolve mappings inline from already-loaded
 * rawMessages — eliminating the race between the `complete` WebSocket event
 * and the file watcher's delayed write.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const LOCALIDS_DIR = path.join(os.homedir(), '.claudecodeui', 'localids');

/**
 * Pending localId mappings awaiting resolution.
 * Each entry: { localMessageId, sessionId (null for new session), projectPath, cursorUUID }
 * Exported as a mutable array so index.js can push/splice directly.
 */
export const pendingLocalIdMappings = [];

/**
 * Persist { localId, serverUUID } to disk so future fetchHistory calls
 * (e.g. after server restart) can still tag historical messages.
 */
export async function saveLocalIdMapping(sessionId, localId, serverUUID) {
  if (!sessionId || !localId || !serverUUID) return;
  try {
    await fs.mkdir(LOCALIDS_DIR, { recursive: true });
    const filePath = path.join(LOCALIDS_DIR, `${sessionId}.json`);
    let entries = [];
    try { entries = JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { /* new file */ }
    if (!entries.some(e => e.localId === localId)) {
      entries.push({ localId, serverUUID });
      await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf8');
    }
  } catch (err) {
    console.warn('[localids] Failed to save mapping:', err?.message);
  }
}

/**
 * Resolve pending localId mappings for a session using already-loaded rawMessages.
 *
 * Called from fetchHistory — the raw messages are already in memory so we can
 * do the cursor-based lookup without any extra file reads or timing dependencies.
 *
 * Returns Map<serverUUID, localId> for all resolved mappings.
 * Resolved entries are removed from pendingLocalIdMappings and persisted to disk.
 */
export function resolvePendingLocalIds(sessionId, projectName, rawMessages) {
  const result = new Map();

  for (let i = pendingLocalIdMappings.length - 1; i >= 0; i--) {
    const pending = pendingLocalIdMappings[i];

    // Match by sessionId (existing session) or by encoded projectPath (new session)
    const matches = pending.sessionId
      ? pending.sessionId === sessionId
      : pending.projectPath.replace(/[^a-zA-Z0-9-]/g, '-') === projectName;

    if (!matches) continue;

    // Find first user message after the cursor UUID recorded at send-time
    let pastCursor = (pending.cursorUUID === null);
    for (const raw of rawMessages) {
      if (!pastCursor) {
        if (raw.uuid === pending.cursorUUID) pastCursor = true;
        continue;
      }
      if (raw.message?.role === 'user' && raw.uuid && raw.message?.content) {
        const hasText = Array.isArray(raw.message.content)
          ? raw.message.content.some(p => p.type === 'text')
          : typeof raw.message.content === 'string';
        if (hasText) {
          result.set(raw.uuid, pending.localMessageId);
          // Don't splice here — resolveLocalIdIfPending (chokidar path) will splice
          // after the disk write completes. Keeping the entry in memory ensures that
          // if the disk write is still in-flight, the next fetchHistory call can still
          // find the mapping via resolvePendingLocalIds.
          saveLocalIdMapping(sessionId, pending.localMessageId, raw.uuid);
          break;
        }
      }
    }
  }

  return result;
}
