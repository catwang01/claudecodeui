// Cross-component invalidation signal for a project's file listing.
//
// The Files tree mutates a project's contents (create / rename / delete /
// upload) and refreshes its own listing, while the chat composer keeps a
// separate copy of the same listing to power `@`-mentions. Without a shared
// revision, a folder that was just deleted keeps being suggested until the user
// reloads the page or switches project.
//
// Producers (file-tree operations) call bumpProjectFileListRevision(); consumers
// (useFileMentions) compare the revision they fetched at against the current one
// and refetch when it moved on.

const revisions = new Map<string, number>();
const listeners = new Set<(projectName: string) => void>();

export function getProjectFileListRevision(projectName: string): number {
  return revisions.get(projectName) ?? 0;
}

export function bumpProjectFileListRevision(projectName: string | null | undefined): void {
  if (!projectName) return;

  revisions.set(projectName, getProjectFileListRevision(projectName) + 1);

  // Copy first: a listener may unsubscribe while we are notifying.
  for (const listener of Array.from(listeners)) {
    listener(projectName);
  }
}

export function subscribeProjectFileListRevision(listener: (projectName: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Test-only: module state must not leak between test cases.
export function resetProjectFileListRevisions(): void {
  revisions.clear();
  listeners.clear();
}
