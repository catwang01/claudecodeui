import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import { scheduledTasksApi } from '../api';
import type { CustomPresetInput, ProjectOption, ScheduledTask } from '../types';
import { describePresetTask, normalizePresetPath } from '../utils/presets';
import { FormField, controlClassName, textAreaClassName } from './FormControls';

type CustomPresetDialogProps = {
  projectOptions: ProjectOption[];
  defaultProjectPath: string;
  isBusy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: CustomPresetInput) => void;
};

/**
 * Builds a custom preset from existing tasks of one project (section 10.3).
 * Tasks are loaded per project and filtered client-side because the task list
 * endpoint has no project filter.
 */
export default function CustomPresetDialog({
  projectOptions,
  defaultProjectPath,
  isBusy,
  error,
  onClose,
  onSubmit,
}: CustomPresetDialogProps) {
  const { t, i18n } = useTranslation('scheduledTasks');
  const locale = i18n.language;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectPath, setProjectPath] = useState(defaultProjectPath);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [tasksError, setTasksError] = useState(false);
  const [validationKey, setValidationKey] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) {
      setTasks([]);
      setTaskIds([]);
      return;
    }
    let cancelled = false;
    setIsLoadingTasks(true);
    setTasksError(false);
    setTaskIds([]);
    void (async () => {
      try {
        const all = await scheduledTasksApi.list({ status: 'all', search: '' });
        if (cancelled) return;
        const target = normalizePresetPath(projectPath);
        setTasks(all.filter((task) => normalizePresetPath(task.projectPath) === target));
      } catch {
        if (!cancelled) {
          setTasks([]);
          setTasksError(true);
        }
      } finally {
        if (!cancelled) setIsLoadingTasks(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const toggleTask = (id: string) => {
    setTaskIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  };

  /** Position follows the task list order, so the resulting preset is predictable. */
  const orderedTaskIds = tasks.filter((task) => taskIds.includes(task.id)).map((task) => task.id);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      setValidationKey('presets.newDialog.errors.name');
      return;
    }
    if (!projectPath.trim()) {
      setValidationKey('presets.newDialog.errors.project');
      return;
    }
    if (orderedTaskIds.length === 0) {
      setValidationKey('presets.newDialog.errors.tasks');
      return;
    }
    setValidationKey(null);
    onSubmit({
      name: name.trim(),
      description: description.trim() ? description.trim() : undefined,
      projectPath: projectPath.trim(),
      taskIds: orderedTaskIds,
    });
  };

  const allSelected = tasks.length > 0 && orderedTaskIds.length === tasks.length;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('presets.newDialog.title')}
    >
      <form
        onSubmit={handleSubmit}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">{t('presets.newDialog.title')}</h2>
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
          <FormField label={t('presets.newDialog.name')} htmlFor="preset-name">
            <input
              id="preset-name"
              type="text"
              className={controlClassName}
              placeholder={t('presets.newDialog.namePlaceholder')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>

          <FormField label={t('presets.newDialog.description')} htmlFor="preset-description">
            <textarea
              id="preset-description"
              className={textAreaClassName}
              placeholder={t('presets.newDialog.descriptionPlaceholder')}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>

          <FormField label={t('presets.project.label')} htmlFor="preset-project-input">
            <select
              id="preset-project-input"
              className={controlClassName}
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
            >
              <option value="">{t('presets.project.placeholder')}</option>
              {projectOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label={t('presets.newDialog.tasks')} hint={t('presets.newDialog.tasksHint')}>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('presets.newDialog.selected', { count: orderedTaskIds.length })}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={tasks.length === 0 || allSelected}
                    onClick={() => setTaskIds(tasks.map((task) => task.id))}
                  >
                    {t('presets.newDialog.selectAll')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={orderedTaskIds.length === 0}
                    onClick={() => setTaskIds([])}
                  >
                    {t('presets.newDialog.clear')}
                  </Button>
                </div>
              </div>

              <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border p-2">
                {isLoadingTasks && (
                  <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('presets.newDialog.loadingTasks')}
                  </div>
                )}
                {!isLoadingTasks && tasksError && (
                  <p className="py-3 text-xs text-destructive">{t('presets.errors.tasks')}</p>
                )}
                {!isLoadingTasks && !tasksError && tasks.length === 0 && (
                  <p className="py-3 text-xs text-muted-foreground">{t('presets.newDialog.noTasks')}</p>
                )}
                {!isLoadingTasks &&
                  tasks.map((task) => (
                    <label
                      key={task.id}
                      className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 transition-colors hover:bg-accent/40"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-primary"
                        checked={taskIds.includes(task.id)}
                        onChange={() => toggleTask(task.id)}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-foreground">{task.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {describePresetTask(task, t, locale)}
                        </span>
                      </span>
                    </label>
                  ))}
              </div>
            </div>
          </FormField>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          <p className="mr-auto min-w-0 text-xs text-destructive">
            {error ?? (validationKey ? t(validationKey) : '')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isBusy}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={isBusy}>
            {isBusy ? t('actions.saving') : t('presets.newDialog.confirm')}
          </Button>
        </div>
      </form>
    </div>
  );
}
