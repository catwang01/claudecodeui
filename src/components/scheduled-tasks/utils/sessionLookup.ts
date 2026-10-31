/**
 * Resolve a scheduled-task run's stored session id against the app's loaded
 * projects payload, so run history can show a readable origin instead of a bare
 * UUID.
 *
 * Kept pure and separate from the API client: the payload is fetched once per
 * run-history mount and every row only runs the local lookup below, so there is
 * no request per row.
 */
import type { Project, ProjectSession } from '../../../types/app';

/** Every provider collection the projects payload can carry. */
export const SESSION_COLLECTIONS = [
  'sessions',
  'cursorSessions',
  'codexSessions',
  'geminiSessions',
  'copilotSessions',
] as const;

export interface ResolvedSession {
  projectName: string;
  title: string;
}

/** Prefer the user-facing title, then the generated summary, then the raw id. */
function sessionTitle(session: ProjectSession, sessionId: string): string {
  if (typeof session.title === 'string' && session.title) return session.title;
  if (typeof session.summary === 'string' && session.summary) return session.summary;
  if (typeof session.name === 'string' && session.name) return session.name;
  return sessionId;
}

/**
 * Look a session id up across every provider collection of every project.
 *
 * Returns null when the id is not part of the payload (project filtered out, or
 * the payload is stale). Callers must treat null as "unknown", not as "this
 * session does not exist" — the session can still be opened by id.
 */
export function findSessionInProjects(projects: Project[], sessionId: string): ResolvedSession | null {
  if (!sessionId) return null;

  for (const project of projects) {
    for (const key of SESSION_COLLECTIONS) {
      const sessions = project[key];
      if (!Array.isArray(sessions)) continue;

      for (const session of sessions) {
        if (!session || session.id !== sessionId) continue;
        return {
          projectName: project.displayName || project.name,
          title: sessionTitle(session, sessionId),
        };
      }
    }
  }

  return null;
}
