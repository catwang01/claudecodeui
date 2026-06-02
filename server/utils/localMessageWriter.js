import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const LOCAL_MESSAGES_DIR = path.join(os.homedir(), '.cloudcli', 'localMessages');

// In-memory cache for readMessages: sessionId → { size, result }
// Incremental reads accumulate parsed messages; cache is valid as long as file size matches.
const _readCache = new Map();

async function _append(sessionId, message) {
  if (!sessionId) return;
  const filePath = path.join(LOCAL_MESSAGES_DIR, `${sessionId}.jsonl`);
  const line = JSON.stringify(message) + '\n';
  try {
    await fs.appendFile(filePath, line, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fs.mkdir(LOCAL_MESSAGES_DIR, { recursive: true });
      await fs.appendFile(filePath, line, 'utf8');
    } else {
      console.error('[localMessageWriter] append failed:', err.message);
    }
  }
  // No need to invalidate cache — next readMessages will detect size change and do incremental read
}

// Fire-and-forget: never blocks the caller
export function appendMessage(sessionId, message) {
  _append(sessionId, message).catch(() => {});
}

// Awaitable variant — use when the caller needs the write to finish before proceeding
export function appendMessageAsync(sessionId, message) {
  return _append(sessionId, message);
}

/**
 * Read all messages from a session's local JSONL file.
 * Incremental: on repeated calls, only reads bytes appended since last read.
 * Returns [] if file doesn't exist.
 */
export async function readMessages(sessionId) {
  if (!sessionId) return [];
  const filePath = path.join(LOCAL_MESSAGES_DIR, `${sessionId}.jsonl`);
  try {
    const stat = await fs.stat(filePath);
    const currentSize = stat.size;
    const cached = _readCache.get(sessionId);

    // Cache hit — file unchanged
    if (cached && cached.size === currentSize) return cached.result;

    // Incremental read: only read new bytes if file grew
    const isIncremental = cached && cached.size < currentSize;
    const startOffset = isIncremental ? cached.size : 0;
    const readSize = currentSize - startOffset;

    let newMessages = [];
    if (readSize > 0) {
      const buf = Buffer.allocUnsafe(readSize);
      const fh = await fs.open(filePath, 'r');
      try {
        await fh.read(buf, 0, readSize, startOffset);
      } finally {
        await fh.close();
      }
      newMessages = buf.toString('utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap(line => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
    }

    const result = isIncremental ? [...cached.result, ...newMessages] : newMessages;
    _readCache.set(sessionId, { size: currentSize, result });
    return result;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('[localMessageWriter] readMessages failed:', err.message);
    return [];
  }
}
