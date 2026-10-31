import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import SettingsToggle from '../../settings/view/SettingsToggle';
import type { Preset, ProjectOption } from '../types';
import { FormField, controlClassName } from './FormControls';

export type InstallPresetValues = {
  projectPath: string;
  enabled: boolean;
};

type InstallPresetDialogProps = {
  preset: Preset;
  projectOptions: ProjectOption[];
  defaultProjectPath: string;
  isBusy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (values: InstallPresetValues) => void;
};

/** Project picker + whole-preset enable flag for POST /presets/:id/install. */
export default function InstallPresetDialog({
  preset,
  projectOptions,
  defaultProjectPath,
  isBusy,
  error,
  onClose,
  onConfirm,
}: InstallPresetDialogProps) {
  const { t } = useTranslation('scheduledTasks');
  const [projectPath, setProjectPath] = useState(defaultProjectPath || preset.projectPath || '');
  const [enabled, setEnabled] = useState(preset.enabled);
  const [validationKey, setValidationKey] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectPath.trim()) {
      setValidationKey('presets.installDialog.errors.project');
      return;
    }
    setValidationKey(null);
    onConfirm({ projectPath: projectPath.trim(), enabled });
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('presets.installDialog.title', { name: preset.name })}
    >
      <form
        onSubmit={handleSubmit}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">
            {t('presets.installDialog.title', { name: preset.name })}
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
          <p className="text-xs text-muted-foreground">
            {t('presets.installDialog.description', { count: preset.taskCount })}
          </p>

          <FormField label={t('presets.project.label')} htmlFor="preset-install-project">
            <select
              id="preset-install-project"
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

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t('presets.installDialog.enable')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('presets.installDialog.enableHint')}</div>
            </div>
            <SettingsToggle
              checked={enabled}
              onChange={setEnabled}
              ariaLabel={t('presets.installDialog.enable')}
              disabled={isBusy}
            />
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          <p className="mr-auto min-w-0 text-xs text-destructive">
            {error ?? (validationKey ? t(validationKey) : '')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isBusy}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={isBusy}>
            {isBusy ? t('presets.actions.installing') : t('presets.installDialog.confirm')}
          </Button>
        </div>
      </form>
    </div>
  );
}
