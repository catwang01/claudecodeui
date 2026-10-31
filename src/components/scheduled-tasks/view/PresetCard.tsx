import { Boxes, ChevronDown, ChevronRight, Download, Loader2, PackagePlus, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import SettingsToggle from '../../settings/view/SettingsToggle';
import type { Preset } from '../types';
import { describePresetTask, isPresetInstalledIn } from '../utils/presets';

type PresetCardProps = {
  preset: Preset;
  /** Project used for the installed badge and the enable/install scoping. */
  projectPath: string;
  isBusy: boolean;
  isExpanded: boolean;
  onToggleExpanded: (preset: Preset) => void;
  onToggleEnabled: (preset: Preset, enabled: boolean) => void;
  onInstall: (preset: Preset) => void;
  /** §16: refresh a built-in preset's installed tasks from the catalog. */
  onUpgrade?: (preset: Preset) => void;
  onDelete: (preset: Preset) => void;
};

/** Number of template rows shown while the card is collapsed. */
const PREVIEW_LIMIT = 3;

export default function PresetCard({
  preset,
  projectPath,
  isBusy,
  isExpanded,
  onToggleExpanded,
  onToggleEnabled,
  onInstall,
  onUpgrade,
  onDelete,
}: PresetCardProps) {
  const { t, i18n } = useTranslation('scheduledTasks');
  const locale = i18n.language;
  const isBuiltin = preset.source === 'builtin';
  const isInstalled = isPresetInstalledIn(preset, projectPath);
  const visibleTasks = isExpanded ? preset.tasks : preset.tasks.slice(0, PREVIEW_LIMIT);
  const hiddenCount = preset.tasks.length - visibleTasks.length;
  const otherProjects = Array.from(new Set((preset.installedProjects ?? []).map((value) => value.trim()))).filter(Boolean);

  return (
    <div className={cn('rounded-xl border border-border bg-card/50', !preset.enabled && 'opacity-80')}>
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {isBuiltin ? (
              <Boxes className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            ) : (
              <PackagePlus className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            )}
            <h3 className="truncate text-sm font-medium text-foreground">{preset.name}</h3>
            <span
              className={cn(
                'inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                isBuiltin ? 'bg-muted text-muted-foreground' : 'bg-accent text-accent-foreground',
              )}
            >
              {t('presets.source.' + preset.source)}
            </span>
            {preset.version && (
              <span className="flex-shrink-0 text-[11px] text-muted-foreground">
                {t('presets.version', { version: preset.version })}
              </span>
            )}
            <span
              className={cn(
                'inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                preset.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              {preset.enabled ? t('status.enabled') : t('status.paused')}
            </span>
            {isInstalled && (
              <span className="inline-flex flex-shrink-0 items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                {t('presets.installed')}
              </span>
            )}
          </div>

          {preset.description && (
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{preset.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{t('presets.taskCount', { count: preset.taskCount })}</span>
            {!isInstalled && otherProjects.length > 0 && (
              <span>{t('presets.installedIn', { count: otherProjects.length })}</span>
            )}
            {preset.tasks.length > 0 && (
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-label={isExpanded ? t('presets.actions.hideTasks') : t('presets.actions.showTasks')}
                title={isExpanded ? t('presets.actions.hideTasks') : t('presets.actions.showTasks')}
                className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => onToggleExpanded(preset)}
              >
                {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {isExpanded ? t('presets.actions.hideTasks') : t('presets.actions.showTasks')}
              </button>
            )}
          </div>

          {visibleTasks.length > 0 && (
            <ul className="space-y-1 rounded-md bg-muted/40 px-2 py-1.5">
              {visibleTasks.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">{task.title}</span>
                  <span>{describePresetTask(task, t, locale)}</span>
                  {task.command && (
                    <Tooltip content={t('card.scriptGate')}>
                      <span
                        aria-label={t('card.scriptGate')}
                        className="inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400"
                      >
                        <Terminal className="h-3 w-3" />
                      </span>
                    </Tooltip>
                  )}
                </li>
              ))}
              {hiddenCount > 0 && (
                <li className="text-xs text-muted-foreground">{t('presets.moreTasks', { count: hiddenCount })}</li>
              )}
            </ul>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 sm:flex-col sm:items-end">
          <SettingsToggle
            checked={preset.enabled}
            onChange={(value) => onToggleEnabled(preset, value)}
            ariaLabel={preset.enabled ? t('presets.actions.disable') : t('presets.actions.enable')}
            disabled={isBusy}
          />
          <div className="flex items-center gap-0.5">
            {isBuiltin && onUpgrade && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                aria-label={t('presets.actions.upgrade')}
                title={t('presets.actions.upgrade')}
                disabled={isBusy}
                onClick={() => onUpgrade(preset)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              aria-label={t('presets.actions.install')}
              title={t('presets.actions.install')}
              disabled={isBusy}
              onClick={() => onInstall(preset)}
            >
              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              aria-label={isBuiltin ? t('presets.actions.uninstall') : t('presets.actions.delete')}
              title={isBuiltin ? t('presets.actions.uninstall') : t('presets.actions.delete')}
              disabled={isBusy}
              onClick={() => onDelete(preset)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
