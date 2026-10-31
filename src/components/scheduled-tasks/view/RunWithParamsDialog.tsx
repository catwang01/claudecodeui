import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import type { ParamDef, ScheduledTask } from '../types';
import {
  hasParamDefault,
  initialRunInputs,
  readRunInput,
  resolveRunOverrides,
  runInputValue,
} from '../utils/params';
import { FormField, controlClassName } from './FormControls';

type RunWithParamsDialogProps = {
  task: ScheduledTask;
  /** Declared parameters of the task, in display order. */
  params: ParamDef[];
  onClose: () => void;
  /** Receives the non-blank overrides; the backend applies the defaults. */
  onSubmit: (params: Record<string, unknown>) => Promise<void>;
};

type ValidationError = { key: string; paramName?: string };

/**
 * Manual run dialog (docs/scheduled-tasks.md section 12.7): prefilled with the
 * task defaults, blank means use the default and a required parameter without a
 * default blocks submit.
 */
export default function RunWithParamsDialog({
  task,
  params,
  onClose,
  onSubmit,
}: RunWithParamsDialogProps) {
  const { t } = useTranslation('scheduledTasks');
  const [inputs, setInputs] = useState<Record<string, string>>(() => initialRunInputs(params));
  const [validation, setValidation] = useState<ValidationError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const setInput = (name: string, value: string) => {
    setInputs((previous) => ({ ...previous, [name]: value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidation(null);
    setSubmitError(null);

    const resolved = resolveRunOverrides(params, inputs);
    if (!resolved.ok) {
      setValidation({ key: resolved.errorKey, paramName: resolved.paramName });
      return;
    }

    setIsBusy(true);
    try {
      await onSubmit(resolved.overrides);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('runParams.title')}
    >
      <form
        onSubmit={handleSubmit}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">
            {t('runParams.title')} · {task.title}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('actions.close')}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <p className="text-xs text-muted-foreground">{t('runParams.hint')}</p>

          {params.map((def) => {
            const type = def.type ?? 'string';
            const fallback = runInputValue(def);
            const value = readRunInput(inputs, def.name);
            return (
              <FormField
                key={def.name}
                label={def.name}
                htmlFor={'scheduled-run-param-' + def.name}
                hint={
                  (def.required ? t('runParams.required') + ' \u00b7 ' : '') +
                  (hasParamDefault(def)
                    ? t('runParams.defaultHint', { value: runInputValue(def) })
                    : t('runParams.noDefault'))
                }
              >
                {type === 'boolean' ? (
                  <select
                    id={'scheduled-run-param-' + def.name}
                    className={controlClassName}
                    value={value}
                    disabled={isBusy}
                    onChange={(event) => setInput(def.name, event.target.value)}
                  >
                    <option value="">{t('runParams.useDefault')}</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    id={'scheduled-run-param-' + def.name}
                    type="text"
                    inputMode={type === 'number' ? 'decimal' : undefined}
                    className={cn(controlClassName, 'font-mono text-xs')}
                    placeholder={fallback || t('runParams.noDefault')}
                    value={value}
                    disabled={isBusy}
                    onChange={(event) => setInput(def.name, event.target.value)}
                  />
                )}
              </FormField>
            );
          })}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          <p className="mr-auto min-w-0 text-xs text-destructive">
            {submitError ??
              (validation ? t(validation.key, { name: validation.paramName }) : '')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isBusy}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={isBusy}>
            {isBusy ? t('runParams.running') : t('runParams.confirm')}
          </Button>
        </div>
      </form>
    </div>
  );
}
