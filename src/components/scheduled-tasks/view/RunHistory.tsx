import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../shared/view/ui';
import { scheduledTasksApi } from '../api';
import type { ScheduledTaskRun } from '../types';
import { formatDateTime, formatDuration, formatRelativeTime, truncate } from '../utils/format';
import StatusPill from './StatusPill';

const PAGE_SIZE = 20;

function RunRow({ run, locale }: { run: ScheduledTaskRun; locale: string }) {
  const { t } = useTranslation('scheduledTasks');
  const duration = run.status === 'running' ? t('runs.inProgress') : formatDuration(run.startedAt, run.finishedAt);

  return (
    <li className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusPill status={run.status} label={t('status.' + run.status)} />
        <span className="text-xs text-muted-foreground">{t('trigger.' + run.trigger)}</span>
        <span className="text-xs text-muted-foreground">{formatDateTime(run.startedAt, locale)}</span>
        <span className="text-xs text-muted-foreground">{formatRelativeTime(run.startedAt, locale)}</span>
        <span className="text-xs text-muted-foreground">
          {t('runs.duration')}: {duration}
        </span>
      </div>

      {run.sessionId && (
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {t('runs.session')}: {run.sessionId}
        </p>
      )}

      {run.error && (
        <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 p-2">
          <p className="text-[11px] font-medium text-destructive">{t('runs.error')}</p>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground/80">
            {truncate(run.error, 400)}
          </p>
        </div>
      )}

      {!run.error && run.output && (
        <div className="mt-2 rounded border border-border/60 bg-muted/30 p-2">
          <p className="text-[11px] font-medium text-muted-foreground">{t('runs.output')}</p>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground/80">
            {truncate(run.output, 400)}
          </p>
        </div>
      )}
    </li>
  );
}

type RunHistoryProps = {
  taskId: string;
  /**
   * Changes whenever the parent task record advances (run count / last run /
   * updated timestamp). Re-fetches an already-mounted history so the card and
   * the run list never disagree after a run-now or a background list refresh.
   */
  refreshToken?: string;
};

export default function RunHistory({ taskId, refreshToken }: RunHistoryProps) {
  const { t, i18n } = useTranslation('scheduledTasks');
  const locale = i18n.language;
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const load = useCallback(
    async (offset: number): Promise<void> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsLoading(true);
      try {
        const data = await scheduledTasksApi.listRuns(taskId, { limit: PAGE_SIZE, offset });
        if (requestId !== requestIdRef.current) return;
        setRuns((previous) => (offset === 0 ? data.runs : [...previous, ...data.runs]));
        setTotal(data.total);
        setError(null);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (requestId === requestIdRef.current) setIsLoading(false);
      }
    },
    [taskId],
  );

  // refreshToken is intentionally an effect dependency: it re-fetches page 0 when
  // the task record changes while this history section is still mounted.
  useEffect(() => {
    void load(0);
  }, [load, refreshToken]);

  const hasMore = runs.length < total;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('runs.title')}</h4>
        {total > 0 && <span className="text-xs text-muted-foreground">{t('runs.count', { shown: runs.length, total })}</span>}
      </div>

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {isLoading && runs.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('loadingRuns')}</p>}

      {!isLoading && runs.length === 0 && !error && (
        <p className="mt-2 text-sm text-muted-foreground">{t('runs.empty')}</p>
      )}

      {runs.length > 0 && (
        <ul className="mt-2 space-y-2">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} locale={locale} />
          ))}
        </ul>
      )}

      {hasMore && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          disabled={isLoading}
          onClick={() => {
            void load(runs.length);
          }}
        >
          {t('actions.loadMore')}
        </Button>
      )}
    </div>
  );
}
