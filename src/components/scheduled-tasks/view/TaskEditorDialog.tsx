import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { PROVIDER_LABELS } from '../../../../shared/providerConstants';
import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import SettingsToggle from '../../settings/view/SettingsToggle';
import { scheduledTasksApi } from '../api';
import type { ConflictPolicy, ParamDef, ProjectOption, RuleDraft, ScheduledTask, TaskRule } from '../types';
import { createDefaultRuleDraft, draftToRule, normalizeRuleKind, ruleToDraft, toTaskRule } from '../utils/rules';
import { draftsToParams, paramsToDrafts, type ParamDraft } from '../utils/params';
import { FormField, controlClassName, textAreaClassName } from './FormControls';
import ParamsEditor from './ParamsEditor';
import RuleEditor from './RuleEditor';

export type TaskEditorValues = {
  provider: string;
  title: string;
  prompt: string;
  projectPath: string;
  /** docs §22: the full project binding; projectPath is the first entry. */
  projectPaths: string[];
  model: string | null;
  /** Script gate command; null clears it. */
  command: string | null;
  /** Script gate timeout in seconds; null when there is no command. */
  commandTimeoutSeconds: number | null;
  enabled: boolean;
  rule: TaskRule;
  /** Declared parameters, normalized for the API (section 12.1). */
  params: ParamDef[];
  /** docs §17 conflict policy. */
  conflictPolicy: ConflictPolicy;
  /** docs §19 tags. */
  tags: string[];
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

const COMMAND_TIMEOUT_MIN = 1;
const COMMAND_TIMEOUT_MAX = 3600;
const COMMAND_TIMEOUT_DEFAULT = 60;

export default function TaskEditorDialog({ task, onClose, onSubmit }: TaskEditorDialogProps) {
  const { t } = useTranslation('scheduledTasks');
  const isEdit = Boolean(task);

  const [title, setTitle] = useState(task?.title ?? '');
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  // §22: a task can be bound to several projects; the editor collects a list.
  const [projectPaths, setProjectPaths] = useState<string[]>(() => {
    if (task?.projectPaths?.length) return task.projectPaths;
    return task?.projectPath ? [task.projectPath] : [];
  });
  const [model, setModel] = useState(task?.model ?? '');
  const [provider, setProvider] = useState(task?.provider ?? 'claude');
  const [command, setCommand] = useState(task?.command ?? '');
  const [commandTimeout, setCommandTimeout] = useState(
    String(task?.commandTimeoutSeconds ?? COMMAND_TIMEOUT_DEFAULT),
  );
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>(task?.conflictPolicy ?? 'skip');
  // §19: a comma-separated input keeps the editor simple; the API receives an array.
  const [tagsText, setTagsText] = useState((task?.tags ?? []).join(', '));
  const [draft, setDraft] = useState<RuleDraft>(() => initialDraft(task));
  const [paramDrafts, setParamDrafts] = useState<ParamDraft[]>(() => paramsToDrafts(task?.params));
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
    for (const path of projectPaths) {
      if (path && !list.some((option) => option.value === path)) {
        list.unshift({ value: path, label: path });
      }
    }
    return list;
  }, [projectOptions, projectPaths]);

  const toggleProject = (value: string) => {
    setProjectPaths((current) =>
      current.includes(value) ? current.filter((path) => path !== value) : [...current, value],
    );
  };

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
    if (projectPaths.length === 0) {
      setValidationKey('editor.errors.projects');
      return;
    }

    const trimmedCommand = command.trim();
    let commandTimeoutSeconds: number | null = null;
    if (trimmedCommand) {
      const parsedTimeout = Number.parseInt(commandTimeout, 10);
      if (
        !Number.isFinite(parsedTimeout) ||
        parsedTimeout < COMMAND_TIMEOUT_MIN ||
        parsedTimeout > COMMAND_TIMEOUT_MAX
      ) {
        setValidationKey('editor.errors.commandTimeout');
        return;
      }
      commandTimeoutSeconds = parsedTimeout;
    }

    const validation = draftToRule(draft);
    if (!validation.ok) {
      setValidationKey(validation.errorKey);
      return;
    }

    const paramValidation = draftsToParams(paramDrafts);
    if (!paramValidation.ok) {
      setValidationKey(paramValidation.errorKey);
      return;
    }

    setIsSaving(true);
    try {
      await onSubmit({
        title: title.trim(),
        prompt: prompt.trim(),
        projectPath: projectPaths[0] ?? '',
        projectPaths,
        provider,
        model: model.trim() ? model.trim() : null,
        command: trimmedCommand ? trimmedCommand : null,
        commandTimeoutSeconds,
        enabled,
        rule: validation.rule,
        params: paramValidation.params,
        conflictPolicy,
        tags: tagsText
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
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

          <FormField
            label={t('editor.fields.projects')}
            htmlFor="scheduled-task-projects"
            hint={projectsError ? t('errors.projects') : t('editor.fields.projectsHint')}
          >
            <div
              id="scheduled-task-projects"
              role="group"
              aria-label={t('editor.fields.projects')}
              className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border p-1"
            >
              {options.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {t('editor.fields.projectPlaceholder')}
                </p>
              )}
              {options.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 transition-colors hover:bg-accent/40"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-primary"
                    checked={projectPaths.includes(option.value)}
                    onChange={() => toggleProject(option.value)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-foreground" title={option.value}>
                      {option.label}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('editor.fields.projectsSelected', { count: projectPaths.length })}
            </p>
          </FormField>

          <FormField label={t('editor.fields.provider')} htmlFor="scheduled-task-provider">
            <select
              id="scheduled-task-provider"
              className={controlClassName}
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                setModel('');
              }}
            >
              {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
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

          <div className="space-y-3">
            <div className="text-sm font-medium text-foreground">{t('editor.fields.scriptGate')}</div>
            <FormField
              label={t('editor.fields.command')}
              htmlFor="scheduled-task-command"
              hint={t('editor.fields.commandHint')}
            >
              <textarea
                id="scheduled-task-command"
                className={cn(textAreaClassName, 'min-h-[72px] font-mono text-xs')}
                placeholder={t('editor.fields.commandPlaceholder')}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </FormField>
            <FormField label={t('editor.fields.commandTimeout')} htmlFor="scheduled-task-command-timeout">
              <input
                id="scheduled-task-command-timeout"
                type="number"
                min={COMMAND_TIMEOUT_MIN}
                max={COMMAND_TIMEOUT_MAX}
                step={1}
                className={cn(controlClassName, 'w-28')}
                value={commandTimeout}
                onChange={(event) => setCommandTimeout(event.target.value)}
              />
            </FormField>
          </div>

          <div className="h-px bg-border" />

          <ParamsEditor drafts={paramDrafts} onChange={setParamDrafts} disabled={isSaving} />

          <div className="h-px bg-border" />

          <RuleEditor draft={draft} onChange={setDraft} />

          <div className="h-px bg-border" />

          <FormField
            label={t('editor.fields.conflictPolicy')}
            htmlFor="scheduled-task-conflict-policy"
            hint={t('editor.fields.conflictPolicyHint')}
          >
            <select
              id="scheduled-task-conflict-policy"
              className={controlClassName}
              value={conflictPolicy}
              onChange={(event) => setConflictPolicy(event.target.value as ConflictPolicy)}
              disabled={isSaving}
            >
              {(['skip', 'queue', 'replace'] as ConflictPolicy[]).map((value) => (
                <option key={value} value={value}>
                  {t('editor.conflictPolicy.' + value)}
                </option>
              ))}
            </select>
          </FormField>

          <FormField
            label={t('editor.fields.tags')}
            htmlFor="scheduled-task-tags"
            hint={t('editor.fields.tagsHint')}
          >
            <input
              id="scheduled-task-tags"
              type="text"
              className={controlClassName}
              value={tagsText}
              placeholder={t('editor.fields.tagsPlaceholder')}
              onChange={(event) => setTagsText(event.target.value)}
              disabled={isSaving}
            />
          </FormField>

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
