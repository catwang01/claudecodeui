import { useTranslation } from 'react-i18next';
import { Tooltip } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import type { ParamDef } from '../types';
import { formatParamValue, hasParamDefault, paramTooltip } from '../utils/params';

type ParamChipsProps = {
  params: ParamDef[];
  className?: string;
};

/** Chip label: the name, plus its default when one is stored. */
function chipLabel(def: ParamDef): string {
  return hasParamDefault(def) ? def.name + '=' + formatParamValue(def.default) : def.name;
}

/**
 * Read-only chips for a task's declared parameters (section 12.7). Each chip
 * carries the description and the SCHEDULED_TASK_PARAM_<NAME> env var in its
 * tooltip and accessible label.
 */
export default function ParamChips({ params, className }: ParamChipsProps) {
  const { t } = useTranslation('scheduledTasks');
  if (params.length === 0) return null;

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1', className)}
      aria-label={t('card.params')}
    >
      {params.map((def) => {
        const tooltip = paramTooltip(def);
        return (
          <Tooltip key={def.name} content={tooltip}>
            <span
              aria-label={tooltip}
              className="inline-flex max-w-[16rem] items-center truncate rounded-full bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {chipLabel(def)}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
