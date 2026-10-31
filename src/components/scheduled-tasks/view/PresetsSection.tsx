import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, Loader2, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import { scheduledTasksApi } from '../api';
import { useScheduledTaskPresets } from '../hooks/useScheduledTaskPresets';
import type { CustomPresetInput, Preset, ProjectOption } from '../types';
import CustomPresetDialog from './CustomPresetDialog';
import { controlClassName } from './FormControls';
import InstallPresetDialog from './InstallPresetDialog';
import type { InstallPresetValues } from './InstallPresetDialog';
import PresetCard from './PresetCard';
import PresetDeleteDialog from './PresetDeleteDialog';

type PresetsSectionProps = {
  /** Called after any action that may have changed real scheduled tasks. */
  onTasksChanged?: () => void;
  /** Called whenever a modal owned by this section opens or closes. */
  onOverlayChange?: (isOpen: boolean) => void;
};

/**
 * Presets tab (section 10.7): the builtin catalog plus custom presets, scoped by
 * a project picker. Installs materialize real tasks, so the parent task list is
 * refreshed through `onTasksChanged` after every mutation.
 */
export default function PresetsSection({ onTasksChanged, onOverlayChange }: PresetsSectionProps) {
  const { t } = useTranslation('scheduledTasks');
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [projectPath, setProjectPath] = useState('');
  const { presets, isLoading, error, refresh, installPreset, setPresetEnabled, createPreset, removePreset } =
    useScheduledTaskPresets(projectPath);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<Preset | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Preset | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isDialogBusy, setIsDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const options = await scheduledTasksApi.listProjectOptions();
        if (cancelled) return;
        setProjectOptions(options);
        setProjectPath((current) => current || options[0]?.value || '');
      } catch {
        // Best effort: without projects the builtin catalog still lists, but
        // install/create stay blocked by their own validation.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isOverlayOpen = Boolean(installTarget || deleteTarget || isCreating);
  useEffect(() => {
    onOverlayChange?.(isOverlayOpen);
  }, [isOverlayOpen, onOverlayChange]);

  const builtinPresets = useMemo(() => presets.filter((preset) => preset.source === 'builtin'), [presets]);
  const customPresets = useMemo(() => presets.filter((preset) => preset.source === 'custom'), [presets]);

  /** Custom presets are project-scoped; builtin ones fall back to the picker. */
  const scopeFor = (preset: Preset): string | undefined => preset.projectPath || projectPath || undefined;

  const handleToggleEnabled = async (preset: Preset, enabled: boolean) => {
    setBusyId(preset.id);
    setActionError(null);
    setResultMessage(null);
    try {
      await setPresetEnabled(preset.id, enabled, { projectPath: scopeFor(preset) });
      onTasksChanged?.();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t(enabled ? 'presets.errors.enable' : 'presets.errors.disable'),
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleInstallConfirm = async (values: InstallPresetValues) => {
    if (!installTarget) return;
    setIsDialogBusy(true);
    setDialogError(null);
    try {
      const result = await installPreset(installTarget.id, values);
      const parts = [
        t('presets.result.installed', { created: result.created.length, updated: result.updated.length }),
      ];
      if (result.skipped.length > 0) parts.push(t('presets.result.skipped', { count: result.skipped.length }));
      setResultMessage(parts.join(' '));
      setInstallTarget(null);
      onTasksChanged?.();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : t('presets.errors.install'));
    } finally {
      setIsDialogBusy(false);
    }
  };

  const handleDeleteConfirm = async (purge: boolean) => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setIsDialogBusy(true);
    setDialogError(null);
    try {
      const removedTasks = await removePreset(target.id, {
        purge,
        projectPath: scopeFor(target),
      });
      setDeleteTarget(null);
      if (removedTasks > 0) {
        setResultMessage(t('presets.result.removed', { count: removedTasks }));
      } else {
        setResultMessage(t(target.source === 'builtin' ? 'presets.result.uninstalled' : 'presets.result.detached'));
      }
      onTasksChanged?.();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : t('presets.errors.delete'));
    } finally {
      setIsDialogBusy(false);
    }
  };

  const handleCreateSubmit = async (input: CustomPresetInput) => {
    setIsDialogBusy(true);
    setDialogError(null);
    try {
      await createPreset(input);
      setIsCreating(false);
      setResultMessage(t('presets.result.created', { name: input.name }));
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : t('presets.errors.create'));
    } finally {
      setIsDialogBusy(false);
    }
  };

  const openCreate = () => {
    setDialogError(null);
    setIsCreating(true);
  };

  const openInstall = (preset: Preset) => {
    setDialogError(null);
    setResultMessage(null);
    setInstallTarget(preset);
  };

  const openDelete = (preset: Preset) => {
    setDialogError(null);
    setDeleteTarget(preset);
  };

  const showEmpty = !isLoading && !error && presets.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          aria-label={t('presets.project.label')}
          className={cn(controlClassName, 'sm:max-w-xs')}
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

        <div className="flex items-center gap-2 sm:ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
            aria-label={t('presets.actions.refresh')}
            title={t('presets.actions.refresh')}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          </Button>
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            {t('presets.actions.newPreset')}
          </Button>
        </div>
      </div>

      {resultMessage && (
        <p className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">{resultMessage}</p>
      )}
      {actionError && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{actionError}</p>
      )}
      {error && presets.length > 0 && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      )}

      {error && presets.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void refresh();
            }}
          >
            {t('actions.retry')}
          </Button>
        </div>
      )}

      {!error && isLoading && presets.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('presets.loading')}
        </div>
      )}

      {showEmpty && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <Boxes className="h-8 w-8 text-muted-foreground/50" />
          <h3 className="text-sm font-medium text-foreground">{t('presets.empty.title')}</h3>
          <p className="max-w-sm text-sm text-muted-foreground">{t('presets.empty.description')}</p>
        </div>
      )}

      {presets.length > 0 && (
        <div className="space-y-5">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('presets.catalogTitle')}
            </h3>
            {builtinPresets.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                projectPath={projectPath}
                isBusy={busyId === preset.id}
                isExpanded={expandedId === preset.id}
                onToggleExpanded={(target) => setExpandedId((current) => (current === target.id ? null : target.id))}
                onToggleEnabled={handleToggleEnabled}
                onInstall={openInstall}
                onDelete={openDelete}
              />
            ))}
            {builtinPresets.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('presets.empty.catalog')}</p>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('presets.customTitle')}
            </h3>
            {customPresets.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                projectPath={projectPath}
                isBusy={busyId === preset.id}
                isExpanded={expandedId === preset.id}
                onToggleExpanded={(target) => setExpandedId((current) => (current === target.id ? null : target.id))}
                onToggleEnabled={handleToggleEnabled}
                onInstall={openInstall}
                onDelete={openDelete}
              />
            ))}
            {customPresets.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('presets.empty.custom')}</p>
            )}
          </section>
        </div>
      )}

      {installTarget && (
        <InstallPresetDialog
          preset={installTarget}
          projectOptions={projectOptions}
          defaultProjectPath={projectPath}
          isBusy={isDialogBusy}
          error={dialogError}
          onClose={() => setInstallTarget(null)}
          onConfirm={(values) => {
            void handleInstallConfirm(values);
          }}
        />
      )}

      {deleteTarget && (
        <PresetDeleteDialog
          preset={deleteTarget}
          isBusy={isDialogBusy}
          error={dialogError}
          onClose={() => setDeleteTarget(null)}
          onConfirm={(purge) => {
            void handleDeleteConfirm(purge);
          }}
        />
      )}

      {isCreating && (
        <CustomPresetDialog
          projectOptions={projectOptions}
          defaultProjectPath={projectPath}
          isBusy={isDialogBusy}
          error={dialogError}
          onClose={() => setIsCreating(false)}
          onSubmit={(input) => {
            void handleCreateSubmit(input);
          }}
        />
      )}
    </div>
  );
}
