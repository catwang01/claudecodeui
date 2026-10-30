import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import type { IntervalUnit, RuleDraft, RuleKind } from '../types';
import { RULE_KINDS, getTimeZoneOptions, getWeekdayLabel } from '../utils/rules';
import { FormField, controlClassName } from './FormControls';

const INTERVAL_UNITS: IntervalUnit[] = ['seconds', 'minutes', 'hours', 'days'];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

type RuleEditorProps = {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  idPrefix?: string;
};

const pillClassName = (selected: boolean) =>
  cn(
    'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
    selected
      ? 'border-primary bg-primary/10 text-primary'
      : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground',
  );

export default function RuleEditor({ draft, onChange, idPrefix = 'scheduled-task' }: RuleEditorProps) {
  const { t, i18n } = useTranslation('scheduledTasks');
  const locale = i18n.language;
  const timeZones = getTimeZoneOptions();
  const update = (patch: Partial<RuleDraft>) => onChange({ ...draft, ...patch });

  const needsTimeZone = draft.kind !== 'once' && draft.kind !== 'interval';

  return (
    <div className="space-y-3">
      <FormField label={t('rule.label')}>
        <div className="flex flex-wrap gap-1.5">
          {RULE_KINDS.map((kind: RuleKind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={draft.kind === kind}
              className={pillClassName(draft.kind === kind)}
              onClick={() => update({ kind })}
            >
              {t('rule.kinds.' + kind)}
            </button>
          ))}
        </div>
      </FormField>

      {draft.kind === 'once' && (
        <FormField label={t('rule.onceAt')} htmlFor={idPrefix + '-once'}>
          <input
            id={idPrefix + '-once'}
            type="datetime-local"
            className={controlClassName}
            value={draft.onceAt}
            onChange={(event) => update({ onceAt: event.target.value })}
          />
        </FormField>
      )}

      {draft.kind === 'interval' && (
        <FormField label={t('rule.interval.every')} htmlFor={idPrefix + '-interval'}>
          <div className="flex gap-2">
            <input
              id={idPrefix + '-interval'}
              type="number"
              min={1}
              step={1}
              className={cn(controlClassName, 'w-28')}
              value={Number.isFinite(draft.intervalValue) ? draft.intervalValue : ''}
              onChange={(event) => update({ intervalValue: Number(event.target.value) })}
            />
            <select
              aria-label={t('rule.interval.every')}
              className={controlClassName}
              value={draft.intervalUnit}
              onChange={(event) => update({ intervalUnit: event.target.value as IntervalUnit })}
            >
              {INTERVAL_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {t('rule.interval.units.' + unit)}
                </option>
              ))}
            </select>
          </div>
        </FormField>
      )}

      {draft.kind === 'cron' && (
        <FormField label={t('rule.cron.expression')} hint={t('rule.cron.hint')} htmlFor={idPrefix + '-cron'}>
          <input
            id={idPrefix + '-cron'}
            type="text"
            spellCheck={false}
            className={cn(controlClassName, 'font-mono')}
            placeholder={t('rule.cron.placeholder')}
            value={draft.cronExpression}
            onChange={(event) => update({ cronExpression: event.target.value })}
          />
        </FormField>
      )}

      {(draft.kind === 'daily' || draft.kind === 'weekly') && (
        <FormField label={t('rule.time')} htmlFor={idPrefix + '-time'}>
          <input
            id={idPrefix + '-time'}
            type="time"
            className={cn(controlClassName, 'w-36')}
            value={draft.time}
            onChange={(event) => update({ time: event.target.value })}
          />
        </FormField>
      )}

      {draft.kind === 'weekly' && (
        <FormField label={t('rule.weekdays')}>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((day) => {
              const selected = draft.weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={selected}
                  className={cn(pillClassName(selected), 'w-11 text-center')}
                  onClick={() =>
                    update({
                      weekdays: selected
                        ? draft.weekdays.filter((value) => value !== day)
                        : [...draft.weekdays, day],
                    })
                  }
                >
                  {getWeekdayLabel(day, locale)}
                </button>
              );
            })}
          </div>
        </FormField>
      )}

      {needsTimeZone && (
        <FormField label={t('rule.timeZone')} htmlFor={idPrefix + '-tz'}>
          <select
            id={idPrefix + '-tz'}
            className={controlClassName}
            value={draft.timeZone}
            onChange={(event) => update({ timeZone: event.target.value })}
          >
            {!timeZones.includes(draft.timeZone) && draft.timeZone && (
              <option value={draft.timeZone}>{draft.timeZone}</option>
            )}
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </FormField>
      )}
    </div>
  );
}
