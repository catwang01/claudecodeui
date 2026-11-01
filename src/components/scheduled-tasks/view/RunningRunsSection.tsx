import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import type { RunningScheduledTaskRun } from '../types';
import { formatDateTime, formatRelativeTime } from '../utils/format';
import StatusPill from './StatusPill';

type RunningRunsSectionProps = {
  runs: RunningScheduledTaskRun[];
  onOpenSession?: (sessionId: string) => void;
};

function basename(value: string | null | undefined): string {
  if (!value) return '';
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : value;
}

/**
 * docs §22: the live list of running scheduled-task runs (an agent is started
 * and the run is still in flight). The script-gate phase is not "running".
 */
export default function RunningRunsSection({ runs, onOpenSession }: RunningRunsSectionProps) {
  const { t, i18n } = useTranslation('scheduledTasks');
  const locale = i18n.language;

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <Clock className="h-8 w-8 text-muted-foreground/50" />
        <h3 className="text-sm font-medium text-foreground">{t('runningRuns.emptyTitle')}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{t('runningRuns.empty')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t('runningRuns.title')}</h3>
        <span className="text-xs text-muted-foreground">
          {t('runningRuns.count', { count: runs.length })}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('runningRuns.hint')}</p>
      <ul className="space-y-2">
        {runs.map((run) => {
          const projectLabel = basename(run.projectPath) || run.projectPath || '';
          const gatePhase = run.agentStartedAt == null;
          return (
            <li key={run.id} className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <StatusPill status="running" label={t('status.running')} />
                <span className="text-sm font-medium text-foreground">{run.taskTitle ?? run.taskId}</span>
                {projectLabel && (
                  <span className="text-xs text-muted-foreground" title={run.projectPath ?? undefined}>
                    {t('runningRuns.project')}: {projectLabel}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">{t('trigger.' + run.trigger)}</span>
                <span className="text-xs text-muted-foreground">
                  {run.startedAt ? formatRelativeTime(run.startedAt, locale) : t('time.unknown')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {run.startedAt ? formatDateTime(run.startedAt, locale) : ''}
                </span>
                <span className="text-xs text-muted-foreground">
                  {gatePhase ? t('runs.gatePhase') : t('runs.inProgress')}
                </span>
              </div>
              {run.sessionId && (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="text-xs text-muted-foreground">
                    {t('runs.session')}: {run.sessionId}
                  </p>
                  {onOpenSession && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      aria-label={t('runs.openSessionAria', { id: run.sessionId })}
                      onClick={() => onOpenSession(run.sessionId as string)}
                    >
                      {t('runs.openSession')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
