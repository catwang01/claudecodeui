import type { Project, ProjectSession } from '../../../types/app';

/**
 * Build a stable string describing *which* sessions the sidebar currently knows about.
 *
 * It deliberately ignores mutable per-session fields (lastActivity, messageCount, …):
 * those change on every streamed token, while this signature only changes when a
 * session is added, removed, or moved between providers.
 *
 * Used by the Recents view, which fetches the server list once when the view opens.
 * A session created afterwards — most visibly a freshly forked conversation — is
 * pushed to the Projects list through `projects_updated` but never reaches Recents
 * until something refetches. Comparing this signature lets Recents refetch exactly
 * when the session set changes, instead of on every streamed update.
 */
export function buildSessionListSignature(
  projects: readonly Project[],
  getProjectSessions: (project: Project) => ProjectSession[],
): string {
  const keys: string[] = [];
  for (const project of projects) {
    for (const session of getProjectSessions(project)) {
      // NUL cannot appear in a provider name or session id, so keys stay unambiguous.
      keys.push(`${session.__provider || 'claude'}\u0000${session.id}`);
    }
  }
  keys.sort();
  return keys.join('\n');
}
