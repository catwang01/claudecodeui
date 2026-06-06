import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectSession } from '../../types/app';
import Shell from '../shell/view/Shell';

type PoolEntry = {
  session: ProjectSession;
  lastActiveAt: number;
};

type ShellSessionPoolProps = {
  project: Project;
  activeSession: ProjectSession | null | undefined;
  isActive: boolean;
};

const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min

export default function ShellSessionPool({
  project,
  activeSession,
  isActive,
}: ShellSessionPoolProps) {
  const [pool, setPool] = useState<Map<string, PoolEntry>>(new Map());
  const projectPathRef = useRef(project.path);

  // When project changes, clear pool so stale sessions from old project are dropped
  useEffect(() => {
    if (projectPathRef.current !== project.path) {
      projectPathRef.current = project.path;
      setPool(new Map());
    }
  }, [project.path]);

  // Add new session to pool when first seen; for existing sessions only update lastActiveAt
  // (preserve the original session object reference so Shell does not get new props)
  useEffect(() => {
    if (!activeSession) return;
    setPool((prev) => {
      const next = new Map(prev);
      const existing = prev.get(activeSession.id);
      if (existing) {
        // Already in pool - preserve session reference, only refresh timestamp
        next.set(activeSession.id, { ...existing, lastActiveAt: Date.now() });
      } else {
        // New session - add to pool
        next.set(activeSession.id, { session: activeSession, lastActiveAt: Date.now() });
      }
      return next;
    });
  }, [activeSession]);

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
      ? [...entries, { session: activeSession, lastActiveAt: Date.now() }]
      : entries;

  if (allEntries.length === 0) {
    return null;
  }

  return (
    <>
      {allEntries.map(({ session }) => {
        const isVisible = session.id === activeSession?.id;
        return (
          <div
            key={session.id}
            className={`h-full w-full ${isVisible ? 'block' : 'hidden'}`}
          >
            <Shell
              selectedProject={project}
              selectedSession={session}
              isActive={isActive && isVisible}
              autoConnect={isActive && isVisible}
            />
          </div>
        );
      })}
    </>
  );
}
