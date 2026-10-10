import { useState } from 'react';
import { useAwaitingPermissions } from '../../contexts/AwaitingPermissionContext';
import { PermissionToast } from './PermissionToast';

const MAX_VISIBLE = 3;

interface PermissionToastContainerProps {
  selectedSessionId: string | undefined;
  getSessionName: (sessionId: string) => string;
  onNavigate: (sessionId: string) => void;
}

export function PermissionToastContainer({
  selectedSessionId,
  getSessionName,
  onNavigate,
}: PermissionToastContainerProps) {
  const { awaitingPermissionSessions } = useAwaitingPermissions();
  const [dismissedRequestIds, setDismissedRequestIds] = useState<Set<string>>(() => new Set());

  const backgroundSessions = [...awaitingPermissionSessions.entries()]
    .filter(([sessionId]) => sessionId !== selectedSessionId)
    .map(([sessionId, entries]) => [
      sessionId,
      entries.filter((entry) => !dismissedRequestIds.has(entry.requestId)),
    ] as const)
    .filter(([, entries]) => entries.length > 0);

  if (backgroundSessions.length === 0) return null;

  const visible = backgroundSessions.slice(0, MAX_VISIBLE);
  const hiddenCount = backgroundSessions.length - visible.length;

  return (
    <div aria-live="polite" className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2">
      {hiddenCount > 0 && (
        <div className="w-72 rounded-lg border border-neutral-600 bg-neutral-800 px-4 py-2 text-xs text-neutral-400">
          ...and {hiddenCount} more waiting
        </div>
      )}
      {visible.map(([sessionId, entries]) => {
        const firstEntry = entries[0];
        if (!firstEntry) return null;
        return (
          <PermissionToast
            key={firstEntry.requestId}
            sessionName={getSessionName(sessionId)}
            toolName={firstEntry.toolName}
            onNavigate={() => onNavigate(sessionId)}
            onDismiss={() => {
              setDismissedRequestIds((previous) => {
                const next = new Set(previous);
                next.add(firstEntry.requestId);
                return next;
              });
            }}
          />
        );
      })}
    </div>
  );
}
