import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Loader2 } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import { scheduledTasksApi } from '../api';
import type { UpcomingOccurrence } from '../types';
import { formatDateTime } from '../utils/format';

/** §21: the next 7 days of runs, grouped by local day. */
export default function UpcomingSection() {
  const { t, i18n } = useTranslation('scheduledTasks');
  const locale = i18n.language;
  const [upcoming, setUpcoming] = useState<UpcomingOccurrence[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const next = await scheduledTasksApi.upcoming({ days: 7, limit: 200 });
      setUpcoming(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups: { day: string; items: UpcomingOccurrence[] }[] = [];
  const index = new Map<string, number>();
  for (const item of upcoming) {
    const day = new Date(item.at).toLocaleDateString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    if (!index.has(day)) {
      index.set(day, groups.length);
      groups.push({ day, items: [] });
    }
    groups[index.get(day) as number].items.push(item);
  }

  if (isLoading && upcoming.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (error && upcoming.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void load();
          }}
        >
          {t('actions.retry')}
        </Button>
      </div>
    );
  }

  if (upcoming.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <CalendarDays className="h-8 w-8 text-muted-foreground/50" />
        <h3 className="text-sm font-medium text-foreground">{t('calendar.emptyTitle')}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{t('calendar.emptyDescription')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('calendar.next7Days')}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void load();
          }}
        >
          {t('actions.refresh')}
        </Button>
      </div>
      {groups.map((group) => (
        <section key={group.day} className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">{group.day}</h4>
          <ul className="space-y-1">
            {group.items.map((item) => (
              <li
                key={item.taskId + item.at}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/50 px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-foreground" title={item.title}>
                  {item.title}
                </span>
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  {formatDateTime(item.at, locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
