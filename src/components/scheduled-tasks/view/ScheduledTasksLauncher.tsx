import { useState } from 'react';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useRunningScheduledTasks } from '../hooks/useRunningScheduledTasks';
import RunningCountBadge from './RunningCountBadge';
import ScheduledTasksPanel from './ScheduledTasksPanel';

/**
 * Sidebar footer entry point. Renders the desktop and mobile button variants
 * (the footer hosts both), shows the running-task count on each (section 14)
 * and mounts the overlay panel through its portal.
 */
export default function ScheduledTasksLauncher() {
  const { t } = useTranslation('scheduledTasks');
  const [isOpen, setIsOpen] = useState(false);
  const { count: runningCount } = useRunningScheduledTasks();
  const runningLabel = t('launcher.running', { count: runningCount });

  const open = () => setIsOpen(true);

  return (
    <>
      <div className="hidden px-2 pt-1.5 md:block">
        <button
          type="button"
          onClick={open}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <Clock className="h-3.5 w-3.5" />
          <span className="text-sm">{t('launcher.label')}</span>
          <RunningCountBadge count={runningCount} label={runningLabel} className="ml-auto" />
        </button>
      </div>

      <div className="px-3 pt-3 md:hidden">
        <button
          type="button"
          onClick={open}
          className="flex h-12 w-full items-center gap-3.5 rounded-xl bg-muted/40 px-4 transition-all hover:bg-muted/60 active:scale-[0.98]"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-background/80">
            <Clock className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-base font-medium text-foreground">{t('launcher.label')}</span>
          <RunningCountBadge count={runningCount} label={runningLabel} className="ml-auto" />
        </button>
      </div>

      {isOpen && <ScheduledTasksPanel onClose={() => setIsOpen(false)} runningCount={runningCount} />}
    </>
  );
}
