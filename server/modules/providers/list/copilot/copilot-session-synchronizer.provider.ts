import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import type { ISessionSynchronizer } from '../../types.js';

const COPILOT_HOME = path.join(os.homedir(), '.copilot');
const COPILOT_DB = path.join(COPILOT_HOME, 'session-store.db');
const COPILOT_SESSION_STATE_DIR = path.join(COPILOT_HOME, 'session-state');

interface CopilotSession {
  id: string;
  cwd: string | null;
  created_at: string;
  updated_at: string;
}

export const copilotSessionSynchronizer: ISessionSynchronizer = {
  provider: 'copilot',

  // Watch session-state directory (like Codex watches sessions/)
  // Each session has its own subdirectory with events.jsonl
  watchPaths: [COPILOT_SESSION_STATE_DIR],

  async synchronize(since: Date | null): Promise<number> {
    console.log('[copilot-sync] Starting synchronization, since:', since);
    let db: Database.Database | null = null;

    try {
      console.log('[copilot-sync] Step 1: Importing fs/promises...');
      // Check if database exists
      const fs = await import('fs/promises');

      console.log('[copilot-sync] Step 2: Checking if DB exists at:', COPILOT_DB);
      try {
        await fs.access(COPILOT_DB);
        console.log('[copilot-sync] Database found at:', COPILOT_DB);
      } catch {
        // Database doesn't exist yet
        console.log('[copilot-sync] Database not found at:', COPILOT_DB);
        return 0;
      }

      console.log('[copilot-sync] Step 3: Opening database...');
      db = new Database(COPILOT_DB, { readonly: true });
      console.log('[copilot-sync] Database opened successfully');

      // Build query based on whether we have a 'since' timestamp
      let query = 'SELECT id, cwd, created_at, updated_at FROM sessions';
      const params: any[] = [];

      if (since) {
        query += ' WHERE updated_at >= ?';
        params.push(since.toISOString());
      }

      const sessions = db.prepare(query).all(...params) as CopilotSession[];
      console.log('[copilot-sync] Found sessions:', sessions.length, 'since:', since?.toISOString() || 'null');

      let count = 0;
      for (const session of sessions) {
        if (!session.id || !session.cwd) {
          continue;
        }

        const projectPath = session.cwd;
        const eventsJsonlPath = path.join(COPILOT_SESSION_STATE_DIR, session.id, 'events.jsonl');

        projectsDb.createProjectPath(projectPath);
        sessionsDb.createSession(
          session.id,
          'copilot',
          projectPath,
          undefined, // name
          session.created_at,
          session.updated_at,
          eventsJsonlPath // ← 填充 jsonlPath
        );

        count++;
      }

      console.log('[copilot-sync] Synchronized', count, 'sessions');
      return count;
    } catch (error) {
      console.warn('[copilot-sync] Failed to synchronize sessions:', error);
      return 0;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  },

  async synchronizeFile(filePath: string): Promise<string | null> {
    // filePath format: ~/.copilot/session-state/{session-id}/events.jsonl
    // Extract session ID from directory name
    const sessionDir = path.dirname(filePath);
    const sessionId = path.basename(sessionDir);

    if (!sessionId || sessionId === 'session-state') {
      return null;
    }

    console.log('[copilot-sync] Synchronizing file for session:', sessionId);

    // Query session metadata from session-store.db
    let db: Database.Database | null = null;
    try {
      const fs = await import('fs/promises');
      try {
        await fs.access(COPILOT_DB);
      } catch {
        console.log('[copilot-sync] Database not found at:', COPILOT_DB);
        return null;
      }

      db = new Database(COPILOT_DB, { readonly: true });

      const session = db.prepare('SELECT id, cwd, created_at, updated_at FROM sessions WHERE id = ?')
        .get(sessionId) as CopilotSession | undefined;

      if (!session || !session.cwd) {
        console.log('[copilot-sync] Session not found in DB:', sessionId);
        return null;
      }

      const projectPath = session.cwd;

      projectsDb.createProjectPath(projectPath);
      sessionsDb.createSession(
        session.id,
        'copilot',
        projectPath,
        undefined, // name
        session.created_at,
        session.updated_at,
        filePath  // ← 使用传入的 filePath (events.jsonl 路径)
      );

      console.log('[copilot-sync] Synchronized session:', sessionId);
      return session.id;
    } catch (error) {
      console.warn('[copilot-sync] Failed to synchronize file:', filePath, error);
      return null;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  },
};
