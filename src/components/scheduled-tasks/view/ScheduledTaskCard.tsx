import { Cpu, FolderOpen, History, Loader2, Pencil, Play, Repeat, Terminal, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import SettingsToggle from '../../settings/view/SettingsToggle';
import type { ScheduledTask } from '../types';
import { formatDateTime, formatRelativeTime } from '../utils/format';
import { describeRule, normalizeRuleKind, toTaskRule } from '../utils/rules';
import RunHistory from './RunHistory';

type ScheduledTaskCardProps = {
  task: ScheduledTask;
  isBusy: boolean;
  isExpanded: boolean;
  onToggleEnabled: (task: ScheduledTask, enabled: boolean) => void;
  onRunNow: (task: ScheduledTask) => void;
  onEdit: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  onToggleHistory: (task: ScheduledTask) => void;
  onOpenSession?: (sessionId: string) => void;
};

/** Last path segment; handles both / and Windows separators without regex escapes. */
function basename(value: string): string {
  const isSeparator = (char: string) => char === '/' || char.charCodeAt(0) === 92;
  let trimmed = value.trim();
  while (trimmed.length > 1 && isSeparator(trimmed.charAt(trimmed.length - 1))) {
    trimmed = trimmed.slice(0, -1);
  }
  let lastSeparator = -1;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (isSeparator(trimmed.charAt(index))) lastSeparator = index;
  }
  return lastSeparator >= 0 ? trimmed.slice(lastSeparator + 1) : trimmed;
}

export default function ScheduledTaskCard({
  task,
  isBusy,
  isExpanded,
  onToggleEnabled,
  onRunNow,
  onEdit,
  onDelete,
  onToggleHistory,
  onOpenSession,
}: ScheduledTaskCardProps) {
  const { t, i18n } = useTranslation('scheduledTasks');
  const locale = i18n.language;
  const rule = toTaskRule(normalizeRuleKind(task.kind || task.rule?.kind), task.rule);

  const nextRunText = task.nextRunAt
    ? formatDateTime(task.nextRunAt, locale) + ' · ' + formatRelativeTime(task.nextRunAt, locale)
    : t('nextRun.none');

  const lastRunText = task.lastRunAt
    ? [task.lastStatus ? t('status.' + task.lastStatus) : null, formatRelativeTime(task.lastRunAt, locale)]
        .filter(Boolean)
        .join(' · ')
    : t('lastRun.never');

  const projectLabel = basename(task.projectPath) || task.projectPath;
  const historyToken = [task.runCount ?? 0, task.lastRunAt ?? '', task.updatedAt ?? ''].join('|');

  return (
    <div className={cn('rounded-xl border border-border bg-card/50', !task.enabled && 'opacity-80')}>
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium text-foreground">{task.title}</h3>
            <span
              className={cn(
                'inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                task.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              {task.enabled ? t('status.enabled') : t('status.paused')}
            </span>
          </div>

          <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{task.prompt}</p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Repeat className="h-3 w-3" />
              {describeRule(rule, t, locale)}
            </span>
            <span className="inline-flex min-w-0 max-w-[16rem] items-center gap-1">
              <FolderOpen className="h-3 w-3 flex-shrink-0" />
              <span className="truncate" title={task.projectPath}>
                {projectLabel}
              </span>
            </span>
            {task.model && (
              <span className="inline-flex items-center gap-1">
                <Cpu className="h-3 w-3" />
                {task.model}
              </span>
            )}
            {task.command && (
              <Tooltip content={t('card.scriptGate')}>
                <span
                  aria-label={t('card.scriptGate')}
                  className="inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400"
                >
                  <Terminal className="h-3 w-3" />
                </span>
              </Tooltip>
            )}
            <span>{t('card.runCount', { count: task.runCount ?? 0 })}</span>
          </div>

          <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            <span>
              {t('nextRun.label')}: <span className="text-foreground/80">{nextRunText}</span>
            </span>
            <span>
              {t('lastRun.label')}: <span className="text-foreground/80">{lastRunText}</span>
            </span>
          </div>

          {task.lastStatus === 'error' && task.lastError && (
            <p className="line-clamp-2 whitespace-pre-wrap break-words rounded bg-destructive/5 px-2 py-1 text-xs text-destructive">
              {task.lastError}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 sm:flex-col sm:items-end">
          <SettingsToggle
            checked={task.enabled}
            onChange={(value) => onToggleEnabled(task, value)}
            ariaLabel={task.enabled ? t('status.paused') : t('status.enabled')}
            disabled={isBusy}
          />
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              aria-label={t('actions.runNow')}
              title={t('actions.runNow')}
              disabled={isBusy}
              onClick={() => onRunNow(task)}
            >
              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              aria-label={t('actions.edit')}
              title={t('actions.edit')}
              disabled={isBusy}
              onClick={() => onEdit(task)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-8 w-8 p-0 text-muted-foreground hover:text-foreground',
                isExpanded && 'bg-accent text-accent-foreground',
              )}
              aria-label={isExpanded ? t('actions.hideHistory') : t('actions.history')}
              title={isExpanded ? t('actions.hideHistory') : t('actions.history')}
              onClick={() => onToggleHistory(task)}
            >
              <History className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              aria-label={t('actions.delete')}
              title={t('actions.delete')}
              disabled={isBusy}
              onClick={() => onDelete(task)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-border">
          <RunHistory taskId={task.id} refreshToken={historyToken} onOpenSession={onOpenSession} />
        </div>
      )}
    </div>
  );
}
