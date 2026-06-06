import { useState, useEffect } from 'react';
import { api } from '../utils/api';

// Module-level cache: projectName → branch (null = no git repo, undefined = not yet fetched)
// Avoids re-fetching when switching tabs within the same project.
const branchCache = new Map<string, string | null>();

/**
 * Lazily fetch the current git branch for a project.
 * Returns undefined while loading, null if the project has no git repo, or the branch name.
 *
 * @param projectName - The project's `name` field (e.g. "Users-edward-MyFolder-myproject")
 */
export function useProjectBranch(projectName: string | null | undefined): string | null | undefined {
  const [branch, setBranch] = useState<string | null | undefined>(() =>
    projectName ? branchCache.get(projectName) : undefined,
  );

  useEffect(() => {
    if (!projectName) {
      setBranch(undefined);
      return;
    }

    // Cache hit — use it directly
    if (branchCache.has(projectName)) {
      setBranch(branchCache.get(projectName)!);
      return;
    }

    let cancelled = false;

    api
      .get(`/git/branch?project=${encodeURIComponent(projectName)}`)
      .then((r) => r.json())
      .then((data: { branch: string | null }) => {
        if (cancelled) return;
        const b = data.branch ?? null;
        branchCache.set(projectName, b);
        setBranch(b);
      })
      .catch(() => {
        if (!cancelled) setBranch(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectName]);

  return branch;
}

/** Invalidate the cached branch for a project (call after git checkout). */
export function invalidateProjectBranchCache(projectName: string): void {
  branchCache.delete(projectName);
}
