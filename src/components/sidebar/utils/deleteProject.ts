/**
 * Pure helpers behind the delete-project confirmation flow.
 *
 * The sidebar only knows about sessions it can see (hidden-from-recents sessions
 * are filtered out of the project payload), while the server's delete guard
 * counts every indexed session for the project. These helpers merge both views
 * so the dialog can be honest about what will be removed and so a server-side
 * 409 ("project still has sessions") can be turned into a second, force-mode
 * confirmation instead of a dead-end alert.
 *
 * No imports on purpose: keep them trivially unit-testable.
 */

/** Minimal project shape needed to read the server-reported session total. */
export type DeleteProjectCandidate = {
  sessionMeta?: { total?: number | null } | null;
};

export type DeleteRequestResolution = {
  /** Sessions the server is expected to delete (visible or not). */
  sessionCount: number;
  /** Sessions that exist on the server but are not shown in the sidebar. */
  hiddenSessionCount: number;
  /** Whether the delete request must be sent with force=true. */
  force: boolean;
};

/**
 * Resolve what the first delete confirmation should show/send.
 *
 * The server total is authoritative about existence; the visible count is used
 * only when the payload carries no total (older payloads, optimistic updates).
 */
export function resolveDeleteRequest(
  project: DeleteProjectCandidate,
  visibleCount: number,
): DeleteRequestResolution {
  const rawServerTotal = Number(project?.sessionMeta?.total ?? 0);
  const serverTotal = Number.isFinite(rawServerTotal) ? rawServerTotal : 0;
  const sessionCount = Math.max(visibleCount, serverTotal);
  const hiddenSessionCount = Math.max(0, sessionCount - visibleCount);

  return {
    sessionCount,
    hiddenSessionCount,
    force: sessionCount > 0,
  };
}

/** JSON body shape the server may return on a failed delete. */
export type DeleteFailureBody =
  | {
      error?: string | null;
      code?: string | null;
      sessionCount?: number | null;
    }
  | null
  | undefined;

export type DeleteFailureInput = {
  status: number;
  body?: DeleteFailureBody;
  /** Session count the client believed before sending the request. */
  fallbackCount: number;
  /** Sessions currently rendered in the sidebar. */
  visibleCount: number;
};

export type DeleteFailureResolution = {
  /** True when the server contradicted the client's count (HTTP 409). */
  needsForceConfirmation: boolean;
  sessionCount: number;
  hiddenSessionCount: number;
};

/**
 * Interpret a failed DELETE /api/projects/:name response.
 *
 * A 409 / PROJECT_HAS_SESSIONS means the client under-counted sessions: the UI
 * should re-open the confirmation in force mode using the server's count. Any
 * other failure keeps the generic error path.
 */
export function resolveDeleteFailure({
  status,
  body,
  fallbackCount,
  visibleCount,
}: DeleteFailureInput): DeleteFailureResolution {
  const rawBodyCount = Number(body?.sessionCount ?? 0);
  const bodyCount = Number.isFinite(rawBodyCount) ? rawBodyCount : 0;
  const safeFallbackCount = Number.isFinite(fallbackCount) ? fallbackCount : 0;
  const sessionCount = Math.max(safeFallbackCount, bodyCount, 1);

  return {
    needsForceConfirmation: status === 409 || body?.code === 'PROJECT_HAS_SESSIONS',
    sessionCount,
    hiddenSessionCount: Math.max(0, sessionCount - visibleCount),
  };
}
