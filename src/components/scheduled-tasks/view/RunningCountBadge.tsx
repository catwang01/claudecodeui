import { cn } from '../../../lib/utils';

type RunningCountBadgeProps = {
  count: number;
  /** Plural-aware accessible label (t('launcher.running', { count })). */
  label: string;
  className?: string;
};

/**
 * Numeric badge for the running-task count (section 14). Renders nothing unless
 * at least one agent is actually running, so no caller ever shows a "0" badge.
 */
export default function RunningCountBadge({ count, label, className }: RunningCountBadgeProps) {
  if (!Number.isFinite(count) || count <= 0) return null;
  return (
    <span
      className={cn(
        'inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground',
        className,
      )}
      aria-label={label}
      data-testid="running-count-badge"
    >
      {count}
    </span>
  );
}
