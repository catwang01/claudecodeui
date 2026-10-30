import { cn } from '../../../lib/utils';
import type { RunStatus } from '../types';

const STATUS_STYLES: Record<RunStatus, string> = {
  running: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  error: 'bg-destructive/15 text-destructive',
  skipped: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

type StatusPillProps = {
  status: RunStatus;
  label: string;
  className?: string;
};

export default function StatusPill({ status, label, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        STATUS_STYLES[status],
        className,
      )}
    >
      {label}
    </span>
  );
}
