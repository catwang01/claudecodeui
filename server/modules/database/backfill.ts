import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';

async function readSessionInfoFromJsonl(
  filePath: string
): Promise<{ sessionId: string | null; cwd: string | null }> {
  return new Promise((resolve) => {
    const fileStream = createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let sessionId: string | null = null;
    let cwd: string | null = null;
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      rl.close();
      fileStream.destroy();
      resolve({ sessionId, cwd });
    }

    rl.on('line', (line) => {
      if (done || !line.trim()) return;
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
        if (entry.cwd && !cwd) cwd = entry.cwd;
        if (sessionId && cwd) finish();
      } catch { /* skip malformed lines */ }
    });

    rl.on('close', finish);
    fileStream.on('error', finish);
  });
}

export async function backfillSessionsFromFileSystem(): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    await fs.access(claudeDir);
  } catch {
    return;
  }

  const db = getConnection();

  // Build a Set of jsonl_paths already in the sessions table for O(1) lookup
  const existingPaths = new Set<string>(
    (db.prepare('SELECT jsonl_path FROM sessions WHERE jsonl_path IS NOT NULL').all() as { jsonl_path: string }[])
      .map(r => r.jsonl_path)
  );

  const projectDirs = (await fs.readdir(claudeDir, { withFileTypes: true }))
    .filter(e => e.isDirectory());

  let inserted = 0;

  for (const dir of projectDirs) {
    const dirPath = path.join(claudeDir, dir.name);
    let files: string[];
    try {
      files = (await fs.readdir(dirPath)).filter(
        f => f.endsWith('.jsonl') && !f.startsWith('agent-')
      );
    } catch { continue; }

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      if (existingPaths.has(filePath)) continue;

      // Fast path: session_file_cache already has session_id and cwd
      const cached = db
        .prepare('SELECT session_id, cwd FROM session_file_cache WHERE file_path = ?')
        .get(filePath) as { session_id: string; cwd: string } | undefined;

      let sessionId: string | null = cached?.session_id ?? null;
      let cwd: string | null = cached?.cwd ?? null;

      if (!sessionId || !cwd) {
        const info = await readSessionInfoFromJsonl(filePath);
        sessionId = sessionId ?? info.sessionId;
        cwd = cwd ?? info.cwd;
      }

      if (!sessionId || !cwd) continue;

      try {
        sessionsDb.createSession(sessionId, 'claude', cwd, undefined, undefined, undefined, filePath);
        inserted++;
      } catch (err) {
        console.warn(`[backfill] Failed to insert ${sessionId}:`, err);
      }
    }
  }

  if (inserted > 0) {
    console.log(`[backfill] Synced ${inserted} missing sessions to DB`);
  }

  scanStateDb.updateLastScannedAt();
}
