import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import SettingsToggle from '../../settings/view/SettingsToggle';
import { scheduledTasksApi } from '../api';
import type { ProjectOption, RuleDraft, ScheduledTask, TaskRule } from '../types';
import { createDefaultRuleDraft, draftToRule, normalizeRuleKind, ruleToDraft, toTaskRule } from '../utils/rules';
import { FormField, controlClassName, textAreaClassName } from './FormControls';
import RuleEditor from './RuleEditor';

export type TaskEditorValues = {
  title: string;
  prompt: string;
  projectPath: string;
  model: string | null;
  enabled: boolean;
  rule: TaskRule;
};

type TaskEditorDialogProps = {
  task: ScheduledTask | null;
  onClose: () => void;
  onSubmit: (values: TaskEditorValues) => Promise<void>;
};

function initialDraft(task: ScheduledTask | null): RuleDraft {
  if (!task) return createDefaultRuleDraft();
  const kind = normalizeRuleKind(task.kind || task.rule?.kind);
  return ruleToDraft(toTaskRule(kind, task.rule));
}

export default function TaskEditorDialog({ task, onClose, onSubmit }: TaskEditorDialogProps) {
  const { t } = useTranslation('scheduledTasks');
  const isEdit = Boolean(task);

  const [title, setTitle] = useState(task?.title ?? '');
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [projectPath, setProjectPath] = useState(task?.projectPath ?? '');
  const [model, setModel] = useState(task?.model ?? '');
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [draft, setDraft] = useState<RuleDraft>(() => initialDraft(task));
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [projectsError, setProjectsError] = useState(false);
  const [validationKey, setValidationKey] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const options = await scheduledTasksApi.listProjectOptions();
        if (!cancelled) setProjectOptions(options);
      } catch {
        if (!cancelled) setProjectsError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => {
    const list = [...projectOptions];
    if (projectPath && !list.some((option) => option.value === projectPath)) {
      list.unshift({ value: projectPath, label: projectPath });
    }
    return list;
  }, [projectOptions, projectPath]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    setValidationKey(null);

    if (!title.trim()) {
      setValidationKey('editor.errors.title');
      return;
    }
    if (!prompt.trim()) {
      setValidationKey('editor.errors.prompt');
      return;
    }
    if (!projectPath.trim()) {
      setValidationKey('editor.errors.project');
      return;
    }

    const validation = draftToRule(draft);
    if (!validation.ok) {
      setValidationKey(validation.errorKey);
      return;
    }

    setIsSaving(true);
    try {
      await onSubmit({
        title: title.trim(),
        prompt: prompt.trim(),
        projectPath: projectPath.trim(),
        model: model.trim() ? model.trim() : null,
        enabled,
        rule: validation.rule,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? t('editor.editTitle') : t('editor.createTitle')}
    >
      <form
        onSubmit={handleSubmit}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">
            {isEdit ? t('editor.editTitle') : t('editor.createTitle')}
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

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <FormField label={t('editor.fields.title')} htmlFor="scheduled-task-title">
            <input
              id="scheduled-task-title"
              type="text"
              className={controlClassName}
              placeholder={t('editor.fields.titlePlaceholder')}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </FormField>

          <FormField label={t('editor.fields.prompt')} htmlFor="scheduled-task-prompt">
            <textarea
              id="scheduled-task-prompt"
              className={textAreaClassName}
              placeholder={t('editor.fields.promptPlaceholder')}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </FormField>

          <FormField label={t('editor.fields.project')} htmlFor="scheduled-task-project" hint={projectsError ? t('errors.projects') : undefined}>
            <select
              id="scheduled-task-project"
              className={controlClassName}
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
            >
              <option value="">{t('editor.fields.projectPlaceholder')}</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label={t('editor.fields.model')} htmlFor="scheduled-task-model">
            <input
              id="scheduled-task-model"
              type="text"
              className={controlClassName}
              placeholder={t('editor.fields.modelPlaceholder')}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </FormField>

          <div className="h-px bg-border" />

          <RuleEditor draft={draft} onChange={setDraft} />

          <div className="h-px bg-border" />

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t('editor.fields.enabled')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('editor.fields.enabledHint')}</div>
            </div>
            <SettingsToggle
              checked={enabled}
              onChange={setEnabled}
              ariaLabel={t('editor.fields.enabled')}
              disabled={isSaving}
            />
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          <p className="mr-auto min-w-0 text-xs text-destructive">
            {submitError ?? (validationKey ? t(validationKey) : '')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isSaving}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={isSaving}>
            {isSaving ? t('actions.saving') : isEdit ? t('actions.save') : t('actions.create')}
          </Button>
        </div>
      </form>
    </div>
  );
}
