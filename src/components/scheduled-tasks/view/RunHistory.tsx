import { MessageSquare } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';
import { scheduledTasksApi } from '../api';
import type { ScheduledTaskRun } from '../types';
import { formatDateTime, formatDuration, formatRelativeTime, truncate } from '../utils/format';
import { formatParamValue } from '../utils/params';
import { findSessionInProjects } from '../utils/sessionLookup';
import StatusPill from './StatusPill';

const PAGE_SIZE = 20;

function RunRow({
  run,
  locale,
  projects,
  onOpenSession,
}: {
  run: ScheduledTaskRun;
  locale: string;
  /** Projects payload fetched once per history mount; null while it loads. */
  projects: Project[] | null;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation('scheduledTasks');
  const duration = run.status === 'running' ? t('runs.inProgress') : formatDuration(run.startedAt, run.finishedAt);
  // Display-only: a null result means the payload does not know this id yet, so
  // the row falls back to showing the raw id and the action stays available.
  const resolvedSession = run.sessionId && projects ? findSessionInProjects(projects, run.sessionId) : null;

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

      {/* Resolved parameter values recorded for this run (section 12.4). */}
      {run.params && Object.keys(run.params).length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1" aria-label={t('runs.params')}>
          <span className="text-[11px] font-medium text-muted-foreground">{t('runs.params')}</span>
          {Object.entries(run.params).map(([name, value]) => (
            <span
              key={name}
              className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
            >
              {name}={formatParamValue(value)}
            </span>
          ))}
        </div>
      )}

      {run.sessionId && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {t('runs.session')}: {run.sessionId}
          </p>
          {resolvedSession && (
            <span
              className="min-w-0 max-w-72 truncate text-[11px] text-foreground/80"
              title={resolvedSession.projectName}
            >
              {resolvedSession.title}
            </span>
          )}
          {onOpenSession && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => onOpenSession(run.sessionId as string)}
              aria-label={t('runs.openSessionAria', { id: run.sessionId })}
              title={t('runs.openSession')}
            >
              <MessageSquare className="h-3 w-3" />
              {t('runs.openSession')}
            </Button>
          )}
        </div>
      )}

      {run.status === 'skipped' && (
        <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2">
          <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">{t('runs.skipReason')}</p>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground/80">
            {truncate(run.output, 400) || t('runs.noReason')}
          </p>
        </div>
      )}

      {run.error && (
        <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 p-2">
          <p className="text-[11px] font-medium text-destructive">{t('runs.error')}</p>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground/80">
            {truncate(run.error, 400)}
          </p>
        </div>
      )}

      {run.status !== 'skipped' && !run.error && run.output && (
        <div className="mt-2 rounded border border-border/60 bg-muted/30 p-2">
          <p className="text-[11px] font-medium text-muted-foreground">{t('runs.output')}</p>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground/80">
            {truncate(run.output, 400)}
          </p>
        </div>
      )}

      {run.promptUsed && (
        <details className="mt-2 rounded border border-border/60 bg-muted/30 p-2">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
            {t('runs.effectivePrompt')}
          </summary>
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-xs text-foreground/80">
            {truncate(run.promptUsed, 600)}
          </p>
        </details>
      )}

      {(run.scriptOutput || typeof run.scriptExitCode === 'number') && (
        <details className="mt-2 rounded border border-border/60 bg-muted/30 p-2">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
            {t('runs.scriptOutput')}
            {typeof run.scriptExitCode === 'number' && (
              <span className="ml-2 text-muted-foreground/80">
                {t('runs.exitCode')}: {run.scriptExitCode}
              </span>
            )}
          </summary>
          {run.scriptOutput && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
              {truncate(run.scriptOutput, 4000)}
            </pre>
          )}
        </details>
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
  /** Opens the agent session this run created (the panel closes and navigates). */
  onOpenSession?: (sessionId: string) => void;
};

export default function RunHistory({ taskId, refreshToken, onOpenSession }: RunHistoryProps) {
  const { t, i18n } = useTranslation('scheduledTasks');
  const locale = i18n.language;
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);

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

  // Resolve each run's session id against the projects payload. Fetched once per
  // mount (and per taskId change) because every row only needs the local lookup.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await scheduledTasksApi.listProjects();
        if (!cancelled) setProjects(loaded);
      } catch {
        // Display-only data: leave it null and rows keep showing the raw id.
        if (!cancelled) setProjects(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const hasMore = runs.length < total;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('runs.title')}</h4>
        {total > 0 && <span className="text-xs text-muted-foreground">{t('runs.count', { shown: runs.length, total })}</span>}
      </div>

      {/* Section 13.7: every run also exports the built-in parameters. */}
      <p className="mt-1 text-[11px] text-muted-foreground">{t('runs.builtinsHint')}</p>

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {isLoading && runs.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('loadingRuns')}</p>}

      {!isLoading && runs.length === 0 && !error && (
        <p className="mt-2 text-sm text-muted-foreground">{t('runs.empty')}</p>
      )}

      {runs.length > 0 && (
        <ul className="mt-2 space-y-2">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              locale={locale}
              projects={projects}
              onOpenSession={onOpenSession}
            />
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
