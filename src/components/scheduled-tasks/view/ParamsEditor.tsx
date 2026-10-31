import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import type { ParamType } from '../types';
import {
  MAX_PARAMS,
  PREDEFINED_PARAMS,
  PREDEFINED_PARAM_GROUPS,
  PARAM_DESCRIPTION_MAX_LENGTH,
  PARAM_NAME_MAX_LENGTH,
  PARAM_NAME_PATTERN,
  PARAM_TYPES,
  createParamDraft,
  paramEnvName,
  type ParamDraft,
} from '../utils/params';
import { FormField, controlClassName } from './FormControls';

type ParamsEditorProps = {
  drafts: ParamDraft[];
  onChange: (drafts: ParamDraft[]) => void;
  disabled?: boolean;
};

/**
 * Parameters section of the task editor (docs/scheduled-tasks.md section 12.7).
 * Purely a controlled list of rows; validation happens on submit in the dialog.
 */
export default function ParamsEditor({ drafts, onChange, disabled = false }: ParamsEditorProps) {
  const { t } = useTranslation('scheduledTasks');

  const updateDraft = (id: string, patch: Partial<Omit<ParamDraft, 'id'>>) => {
    onChange(drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  };

  const removeDraft = (id: string) => {
    onChange(drafts.filter((draft) => draft.id !== id));
  };

  const addDraft = () => {
    if (drafts.length >= MAX_PARAMS) return;
    onChange([...drafts, createParamDraft()]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t('editor.params.title')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('editor.params.hint')}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 flex-shrink-0 gap-1"
          aria-label={t('editor.params.add')}
          disabled={disabled || drafts.length >= MAX_PARAMS}
          onClick={addDraft}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('editor.params.add')}
        </Button>
      </div>

      {/* Section 13.1/13.7: the built-ins are always available, so the editor
          tells the author to read them from the environment instead of
          hardcoding a path. */}
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/10 p-3">
        <p className="text-xs font-medium text-foreground">{t('editor.params.builtins.title')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('editor.params.builtins.hint')}</p>
        <ul className="mt-2 space-y-2">
          {PREDEFINED_PARAM_GROUPS.map((group) => {
            const entries = PREDEFINED_PARAMS.filter((param) => param.group === group);
            if (entries.length === 0) return null;
            return (
              <li key={group}>
                <p className="text-[11px] font-medium text-muted-foreground">
                  {t('editor.params.builtins.group.' + group)}
                </p>
                <ul className="mt-1 space-y-1">
                  {entries.map((param) => (
                    <li key={param.envName} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                      <code className="font-mono text-[11px] text-foreground/80">{param.envName}</code>
                      <span className="text-muted-foreground">
                        {t('editor.params.builtins.' + param.name)}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>

      {drafts.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('editor.params.none')}</p>
      )}

      {drafts.map((draft) => {
        // Surrounding whitespace is invalid rather than trimmed (review N5).
        const name = draft.name;
        const nameValid = PARAM_NAME_PATTERN.test(name);
        return (
          <div key={draft.id} className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">
                {nameValid ? paramEnvName(name) : t('editor.params.envPlaceholder')}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 flex-shrink-0 p-0 text-muted-foreground hover:text-destructive"
                aria-label={t('editor.params.remove')}
                title={t('editor.params.remove')}
                disabled={disabled}
                onClick={() => removeDraft(draft.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <FormField label={t('editor.params.name')} htmlFor={'scheduled-param-name-' + draft.id}>
                <input
                  id={'scheduled-param-name-' + draft.id}
                  type="text"
                  className={cn(controlClassName, 'font-mono text-xs')}
                  placeholder={t('editor.params.namePlaceholder')}
                  maxLength={PARAM_NAME_MAX_LENGTH}
                  value={draft.name}
                  disabled={disabled}
                  onChange={(event) => updateDraft(draft.id, { name: event.target.value })}
                />
              </FormField>

              <FormField label={t('editor.params.type')} htmlFor={'scheduled-param-type-' + draft.id}>
                <select
                  id={'scheduled-param-type-' + draft.id}
                  className={controlClassName}
                  value={draft.type}
                  disabled={disabled}
                  onChange={(event) =>
                    updateDraft(draft.id, { type: event.target.value as ParamType, default: '' })
                  }
                >
                  {PARAM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t('editor.params.types.' + type)}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <FormField
                label={t('editor.params.default')}
                htmlFor={'scheduled-param-default-' + draft.id}
                hint={
                  draft.required && draft.default.trim() === ''
                    ? t('editor.params.requiredNoDefault')
                    : undefined
                }
              >
                {draft.type === 'boolean' ? (
                  <select
                    id={'scheduled-param-default-' + draft.id}
                    className={controlClassName}
                    value={draft.default}
                    disabled={disabled}
                    onChange={(event) => updateDraft(draft.id, { default: event.target.value })}
                  >
                    <option value="">{t('editor.params.noDefault')}</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    id={'scheduled-param-default-' + draft.id}
                    type="text"
                    inputMode={draft.type === 'number' ? 'decimal' : undefined}
                    className={cn(controlClassName, 'font-mono text-xs')}
                    placeholder={t('editor.params.noDefault')}
                    value={draft.default}
                    disabled={disabled}
                    onChange={(event) => updateDraft(draft.id, { default: event.target.value })}
                  />
                )}
              </FormField>

              <FormField label={t('editor.params.description')} htmlFor={'scheduled-param-description-' + draft.id}>
                <input
                  id={'scheduled-param-description-' + draft.id}
                  type="text"
                  className={controlClassName}
                  placeholder={t('editor.params.descriptionPlaceholder')}
                  maxLength={PARAM_DESCRIPTION_MAX_LENGTH}
                  value={draft.description}
                  disabled={disabled}
                  onChange={(event) => updateDraft(draft.id, { description: event.target.value })}
                />
              </FormField>
            </div>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                aria-label={t('editor.params.required')}
                checked={draft.required}
                disabled={disabled}
                onChange={(event) =>
                  updateDraft(draft.id, {
                    required: event.target.checked,
                    // Required is only meaningful without a default (section 12.1).
                    ...(event.target.checked ? { default: '' } : {}),
                  })
                }
              />
              {t('editor.params.required')}
            </label>
          </div>
        );
      })}
    </div>
  );
}
