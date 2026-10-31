import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import SettingsToggle from '../../settings/view/SettingsToggle';
import { scheduledTasksApi } from '../api';
import type { ProjectOption, ScheduledTask } from '../types';
import { FormField, controlClassName } from './FormControls';

export type CopyTaskValues = {
  title: string;
  projectPath: string;
  enabled: boolean;
};

type CopyTaskDialogProps = {
  task: ScheduledTask;
  isBusy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (values: CopyTaskValues) => void;
};

function dedupeOptions(options: ProjectOption[], extra: string): ProjectOption[] {
  const seen = new Set<string>();
  const out: ProjectOption[] = [];
  if (extra.trim()) {
    out.push({ value: extra, label: extra });
    seen.add(extra);
  }
  for (const option of options) {
    if (!option.value || seen.has(option.value)) continue;
    seen.add(option.value);
    out.push(option);
  }
  return out;
}

/**
 * Copy dialog (§15): the copy keeps the task definition but is created paused by
 * default, so duplicating a task can never silently double its schedule.
 */
export default function CopyTaskDialog({ task, isBusy, error, onClose, onConfirm }: CopyTaskDialogProps) {
  const { t } = useTranslation('scheduledTasks');
  const [title, setTitle] = useState(t('copyDialog.defaultTitle', { title: task.title }));
  const [projectPath, setProjectPath] = useState(task.projectPath || '');
  const [enabled, setEnabled] = useState(false);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const options = await scheduledTasksApi.listProjectOptions();
        if (!cancelled) setProjectOptions(options);
      } catch {
        // Best effort: the task's own project is always offered below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) {
      setValidationError(t('copyDialog.errors.title'));
      return;
    }
    if (!projectPath.trim()) {
      setValidationError(t('copyDialog.errors.project'));
      return;
    }
    setValidationError(null);
    onConfirm({ title: title.trim(), projectPath: projectPath.trim(), enabled });
  };

  const options = dedupeOptions(projectOptions, task.projectPath);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('copyDialog.title', { title: task.title })}
    >
      <form
        onSubmit={handleSubmit}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">
            {t('copyDialog.title', { title: task.title })}
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
          <p className="text-xs text-muted-foreground">{t('copyDialog.description')}</p>

          <FormField label={t('copyDialog.fields.title')} htmlFor="copy-task-title">
            <input
              id="copy-task-title"
              type="text"
              className={controlClassName}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={isBusy}
            />
          </FormField>

          <FormField label={t('copyDialog.fields.project')} htmlFor="copy-task-project">
            <select
              id="copy-task-project"
              className={controlClassName}
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              disabled={isBusy}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t('copyDialog.fields.enabled')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('copyDialog.fields.enabledHint')}</div>
            </div>
            <SettingsToggle
              checked={enabled}
              onChange={setEnabled}
              ariaLabel={t('copyDialog.fields.enabled')}
              disabled={isBusy}
            />
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          <p className="mr-auto min-w-0 text-xs text-destructive">{error ?? validationError ?? ''}</p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isBusy}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={isBusy}>
            {isBusy ? t('copyDialog.copying') : t('copyDialog.confirm')}
          </Button>
        </div>
      </form>
    </div>
  );
}
