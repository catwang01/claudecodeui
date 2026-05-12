import { useEffect, useRef, useState } from 'react';

const DURATION_MS = 8000;

interface PermissionToastProps {
  sessionName: string;
  toolName: string;
  onNavigate: () => void;
  onDismiss: () => void;
}

export function PermissionToast({ sessionName, toolName, onNavigate, onDismiss }: PermissionToastProps) {
  const [elapsed, setElapsed] = useState(0);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed((prev) => {
        const next = prev + 100;
        if (next >= DURATION_MS) {
          clearInterval(interval);
          onDismissRef.current();
        }
        return next;
      });
    }, 100);
    return () => clearInterval(interval);
  }, []);

  const progress = Math.min((elapsed / DURATION_MS) * 100, 100);

  return (
    <div className="relative flex w-72 flex-col overflow-hidden rounded-lg border border-amber-500/40 bg-neutral-900 shadow-lg">
      <button
        aria-label="close"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        className="absolute right-2 top-2 text-neutral-400 hover:text-neutral-200"
      >
        x
      </button>
      <div
        role="button"
        tabIndex={0}
        onClick={onNavigate}
        onKeyDown={(e) => e.key === 'Enter' && onNavigate()}
        className="cursor-pointer px-4 pb-3 pt-3 pr-8"
      >
        <p className="text-xs font-semibold text-amber-400">{sessionName}</p>
        <p className="mt-0.5 text-xs text-neutral-300">
          Waiting for permission: <span className="font-mono text-amber-300">{toolName}</span>
        </p>
      </div>
      <div className="h-0.5 w-full bg-neutral-700">
        <div
          className="h-full bg-amber-500 transition-none"
          style={{ width: `${100 - progress}%` }}
        />
      </div>
    </div>
  );
}
