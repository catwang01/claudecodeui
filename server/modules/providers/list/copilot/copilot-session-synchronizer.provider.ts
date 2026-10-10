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
  summary: string | null;
  created_at: string;
  updated_at: string;
}

function getCloudCliSession(nativeSessionId: string) {
  return sessionsDb.getSessionByProviderSessionId('copilot', nativeSessionId)
    ?? sessionsDb.getSessionById(nativeSessionId);
}

function getPreferredJsonlPath(
  nativeSessionId: string,
  nativeEventsPath: string,
  hasNativeEvents: boolean
): string {
  if (hasNativeEvents) {
    return nativeEventsPath;
  }
  const existing = getCloudCliSession(nativeSessionId);
  if (
    existing?.provider === 'copilot'
    && existing.jsonl_path
    && path.basename(existing.jsonl_path) !== 'events.jsonl'
  ) {
    return existing.jsonl_path;
  }
  return nativeEventsPath;
}

async function synchronizeCopilotSessionById(nativeSessionId: string): Promise<{
  sessionId: string | null;
  hasSummary: boolean;
}> {
  let db: Database.Database | null = null;
  try {
    const fs = await import('fs/promises');
    try {
      await fs.access(COPILOT_DB);
    } catch {
      return { sessionId: null, hasSummary: false };
    }

    db = new Database(COPILOT_DB, { readonly: true });
    const session = db.prepare('SELECT id, cwd, summary, created_at, updated_at FROM sessions WHERE id = ?')
      .get(nativeSessionId) as CopilotSession | undefined;

    if (!session?.cwd) {
      return { sessionId: null, hasSummary: false };
    }

    const existingSession = getCloudCliSession(session.id);
    const cloudCliSessionId = existingSession?.session_id ?? session.id;
    const eventsJsonlPath = path.join(COPILOT_SESSION_STATE_DIR, session.id, 'events.jsonl');
    let hasEventsJsonl = true;
    try {
      await fs.access(eventsJsonlPath);
    } catch {
      hasEventsJsonl = false;
    }

    projectsDb.createProjectPath(session.cwd);
    sessionsDb.createSession(
      cloudCliSessionId,
      'copilot',
      session.cwd,
      hasEventsJsonl ? undefined : session.summary || undefined,
      session.created_at,
      session.updated_at,
      getPreferredJsonlPath(session.id, eventsJsonlPath, hasEventsJsonl),
      session.id
    );

    const summary = session.summary?.trim() || '';
    if (summary) {
      sessionsDb.updateSessionGeneratedSummaryIfEmpty(cloudCliSessionId, summary);
    }
    if (
      hasEventsJsonl
      && summary
      && existingSession?.custom_name === summary
    ) {
      sessionsDb.clearSessionCustomNameIfMatches(cloudCliSessionId, summary);
    }

    return { sessionId: cloudCliSessionId, hasSummary: Boolean(summary) };
  } catch (error) {
    console.warn('[copilot-sync] Failed to synchronize session:', nativeSessionId, error);
    return { sessionId: null, hasSummary: false };
  } finally {
    db?.close();
  }
}

export async function waitForCopilotSessionSummary(
  nativeSessionId: string,
  options: { maxWaitMs?: number; pollIntervalMs?: number } = {}
): Promise<string | null> {
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + maxWaitMs;

  while (true) {
    const result = await synchronizeCopilotSessionById(nativeSessionId);
    if (result.hasSummary) {
      return result.sessionId;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(pollIntervalMs, remainingMs));
      timer.unref?.();
    });
  }
}

export const copilotSessionSynchronizer: ISessionSynchronizer = {
  provider: 'copilot',

  // Each session directory contains events.jsonl, session.db, or both.
  watchPaths: [COPILOT_SESSION_STATE_DIR],

  async synchronize(since: Date | null): Promise<number> {
    console.log('[copilot-sync] Starting full synchronization');
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

      // Copilot support may be enabled after the shared scan cursor has advanced.
      // The local metadata table is small and upserts are idempotent, so always
      // reconcile every row to backfill sessions missed by older installations.
      const sessions = db
        .prepare('SELECT id, cwd, summary, created_at, updated_at FROM sessions')
        .all() as CopilotSession[];
      console.log('[copilot-sync] Found sessions:', sessions.length);

      let count = 0;
      for (const session of sessions) {
        if (!session.id || !session.cwd) {
          continue;
        }

        const projectPath = session.cwd;
        const eventsJsonlPath = path.join(COPILOT_SESSION_STATE_DIR, session.id, 'events.jsonl');
        const existingSession = getCloudCliSession(session.id);
        const cloudCliSessionId = existingSession?.session_id ?? session.id;
        const summary = session.summary?.trim() || '';
        const updatedAtMs = Date.parse(session.updated_at);
        const isWithinScanWindow = !since
          || Number.isNaN(updatedAtMs)
          || updatedAtMs >= since.getTime();

        if (!existingSession && !isWithinScanWindow) {
          continue;
        }

        if (existingSession && !isWithinScanWindow) {
          if (summary) {
            sessionsDb.updateSessionGeneratedSummaryIfEmpty(cloudCliSessionId, summary);
          }
          if (
            summary
            && existingSession.custom_name === summary
            && existingSession.jsonl_path
            && path.basename(existingSession.jsonl_path) !== 'events.jsonl'
          ) {
            sessionsDb.clearSessionCustomNameIfMatches(cloudCliSessionId, summary);
          }
          count++;
          continue;
        }

        let hasEventsJsonl = true;
        try {
          await fs.access(eventsJsonlPath);
        } catch {
          hasEventsJsonl = false;
        }

        projectsDb.createProjectPath(projectPath);
        sessionsDb.createSession(
          cloudCliSessionId,
          'copilot',
          projectPath,
          hasEventsJsonl ? undefined : session.summary || undefined,
          session.created_at,
          session.updated_at,
          getPreferredJsonlPath(session.id, eventsJsonlPath, hasEventsJsonl),
          session.id
        );
        if (summary) {
          sessionsDb.updateSessionGeneratedSummaryIfEmpty(cloudCliSessionId, summary);
        }
        if (
          hasEventsJsonl
          && summary
          && existingSession?.custom_name === summary
        ) {
          sessionsDb.clearSessionCustomNameIfMatches(cloudCliSessionId, summary);
        }

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
    // filePath format: ~/.copilot/session-state/{session-id}/events.jsonl or session.db
    // Extract session ID from directory name
    const sessionDir = path.dirname(filePath);
    const sessionId = path.basename(sessionDir);

    if (!sessionId || sessionId === 'session-state') {
      return null;
    }

    console.log('[copilot-sync] Synchronizing file for session:', sessionId);
    const result = await synchronizeCopilotSessionById(sessionId);
    return result.sessionId;
  },
};
