import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../shared/view/ui';
import type { Preset } from '../types';

type PresetDeleteDialogProps = {
  preset: Preset;
  isBusy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (purge: boolean) => void;
};

/**
 * Builtin presets are uninstalled (their real tasks are removed, the catalog row
 * stays). Custom presets are deleted and the user chooses whether the tasks they
 * installed go with them (section 10.3 delete semantics).
 */
export default function PresetDeleteDialog({
  preset,
  isBusy,
  error,
  onClose,
  onConfirm,
}: PresetDeleteDialogProps) {
  const { t } = useTranslation('scheduledTasks');
  const isBuiltin = preset.source === 'builtin';
  const [purge, setPurge] = useState(true);
  const installedProjects = (preset.installedProjects ?? []).length;

  const title = isBuiltin ? t('presets.uninstallDialog.title') : t('presets.deleteDialog.title');
  const description = isBuiltin
    ? t('presets.uninstallDialog.description', { name: preset.name })
    : t('presets.deleteDialog.description', { name: preset.name });

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-5 shadow-2xl">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>

        {!isBuiltin && (
          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              checked={purge}
              onChange={(event) => setPurge(event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm text-foreground">{t('presets.deleteDialog.purge')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {purge ? t('presets.deleteDialog.purgeHint') : t('presets.deleteDialog.keepHint')}
              </span>
            </span>
          </label>
        )}

        {!isBuiltin && installedProjects > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('presets.installedIn', { count: installedProjects })}
          </p>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isBusy}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={isBusy}
            onClick={() => onConfirm(isBuiltin ? false : purge)}
          >
            {isBuiltin ? t('presets.uninstallDialog.confirm') : t('presets.deleteDialog.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
