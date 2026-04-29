import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const LOCAL_MESSAGES_DIR = path.join(os.homedir(), '.cloudcli', 'localMessages');

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
 * Returns an empty array if the file doesn't exist.
 */
export async function readMessages(sessionId) {
  if (!sessionId) return [];
  const filePath = path.join(LOCAL_MESSAGES_DIR, `${sessionId}.jsonl`);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('[localMessageWriter] readMessages failed:', err.message);
    return [];
  }
}
