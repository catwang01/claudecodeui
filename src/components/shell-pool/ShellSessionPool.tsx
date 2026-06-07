import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectSession } from '../../types/app';
import Shell from '../shell/view/Shell';

type PoolEntry = {
  session: ProjectSession;
  // Store the project alongside the session so Shell instances survive project
  // switches — the pool is no longer cleared when the active project changes.
  project: Project;
  lastActiveAt: number;
};

type ShellSessionPoolProps = {
  project: Project;
  activeSession: ProjectSession | null | undefined;
  isActive: boolean;
  onSessionProcessing?: ((sessionId: string) => void) | null;
  onSessionNotProcessing?: ((sessionId: string) => void) | null;
};

const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min

export default function ShellSessionPool({
  project,
  activeSession,
  isActive,
  onSessionProcessing = null,
  onSessionNotProcessing = null,
}: ShellSessionPoolProps) {
  const [pool, setPool] = useState<Map<string, PoolEntry>>(new Map());

  // Add new session to pool when first seen; for existing sessions only update lastActiveAt
  // (preserve the original session + project references so Shell does not get new props)
  useEffect(() => {
    if (!activeSession) return;
    setPool((prev) => {
      const next = new Map(prev);
      const existing = prev.get(activeSession.id);
      if (existing) {
        // Already in pool — preserve session/project references, only refresh timestamp
        next.set(activeSession.id, { ...existing, lastActiveAt: Date.now() });
      } else {
        // New session — capture both session and project at entry time
        next.set(activeSession.id, { session: activeSession, project, lastActiveAt: Date.now() });
      }
      return next;
    });
  }, [activeSession, project]);

  // Cleanup idle sessions every 5 minutes
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setPool((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, entry] of next) {
          if (id !== activeSession?.id && now - entry.lastActiveAt > IDLE_TIMEOUT_MS) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, CLEANUP_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [activeSession?.id]);

  // Collect all entries; ensure activeSession is always present even before state settles
  const entries = Array.from(pool.values());
  const allEntries =
    activeSession && !pool.has(activeSession.id)
      ? [...entries, { session: activeSession, project, lastActiveAt: Date.now() }]
      : entries;

  if (allEntries.length === 0) {
    return null;
  }

  return (
    <>
      {allEntries.map(({ session, project: entryProject }) => {
        const isVisible = session.id === activeSession?.id;
        return (
          <div
            key={session.id}
            className={`h-full w-full ${isVisible ? 'block' : 'hidden'}`}
          >
            <Shell
              selectedProject={entryProject}
              selectedSession={session}
              isActive={isActive && isVisible}
              autoConnect={isActive && isVisible}
              onSessionProcessing={onSessionProcessing}
              onSessionNotProcessing={onSessionNotProcessing}
            />
          </div>
        );
      })}
    </>
  );
}
