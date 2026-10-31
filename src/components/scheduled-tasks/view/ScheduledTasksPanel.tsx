import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Clock, Loader2, Plus, RefreshCw, Search, Upload, X } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useScheduledTasks } from '../hooks/useScheduledTasks';
import { scheduledTasksApi } from '../api';
import type { ImportTaskInput, ScheduledTask, ScheduledTaskInput, TaskPreview, TaskStatusFilter } from '../types';
import { taskParams } from '../utils/params';
import ConfirmDialog from './ConfirmDialog';
import CopyTaskDialog from './CopyTaskDialog';
import type { CopyTaskValues } from './CopyTaskDialog';
import PreviewDialog from './PreviewDialog';
import UpcomingSection from './UpcomingSection';
import { controlClassName } from './FormControls';
import PresetsSection from './PresetsSection';
import RunningCountBadge from './RunningCountBadge';
import RunWithParamsDialog from './RunWithParamsDialog';
import ScheduledTaskCard from './ScheduledTaskCard';
import TaskEditorDialog from './TaskEditorDialog';
import type { TaskEditorValues } from './TaskEditorDialog';

type ScheduledTasksPanelProps = {
  onClose: () => void;
  /**
   * Tasks whose agent has actually started (section 14). Optional so existing
   * callers/tests render the panel unchanged; 0 hides the badge.
   */
  runningCount?: number;
};

type PanelTab = 'tasks' | 'calendar' | 'presets';

/** A filesystem-safe name for a downloaded task envelope. */
function exportFileName(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${cleaned || 'scheduled-task'}.scheduled-task.json`;
}

const STATUS_FILTERS: TaskStatusFilter[] = ['all', 'enabled', 'paused'];
const PANEL_TABS: PanelTab[] = ['tasks', 'calendar', 'presets'];

export default function ScheduledTasksPanel({ onClose, runningCount = 0 }: ScheduledTasksPanelProps) {
  const { t } = useTranslation('scheduledTasks');
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<PanelTab>('tasks');
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 250);
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>('all');
  const [tagInput, setTagInput] = useState('');
  const tag = useDebouncedValue(tagInput, 250);
  const { tasks, isLoading, error, refresh, createTask, updateTask, deleteTask, runNow } = useScheduledTasks({
    status: statusFilter,
    search,
    tag,
  });

  // §20 preview dialog state
  const [previewTarget, setPreviewTarget] = useState<ScheduledTask | null>(null);
  const [previewResult, setPreviewResult] = useState<TaskPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editorTask, setEditorTask] = useState<ScheduledTask | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledTask | null>(null);
  // Tasks with declared parameters open the Run with parameters dialog first.
  const [runDialogTask, setRunDialogTask] = useState<ScheduledTask | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // §17: a non-error notice (e.g. the run was queued behind the active one).
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // Presets own their dialogs; this only stops Escape from closing the panel behind them.
  const [isPresetOverlayOpen, setIsPresetOverlayOpen] = useState(false);
  // §15/§16 copy + portability
  const [copyTarget, setCopyTarget] = useState<ScheduledTask | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !isEditorOpen &&
        !pendingDelete &&
        !isPresetOverlayOpen &&
        !runDialogTask &&
        !copyTarget &&
        !previewTarget
      ) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isEditorOpen, pendingDelete, isPresetOverlayOpen, runDialogTask, copyTarget, previewTarget]);

  const openCreate = () => {
    setEditorTask(null);
    setActionError(null);
    setIsEditorOpen(true);
  };

  const openEdit = (task: ScheduledTask) => {
    setEditorTask(task);
    setActionError(null);
    setIsEditorOpen(true);
  };

  const handleToggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    setBusyTaskId(task.id);
    setActionError(null);
    try {
      await updateTask(task.id, { enabled });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('errors.update'));
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleRunNow = async (task: ScheduledTask, params?: Record<string, unknown>) => {
    setBusyTaskId(task.id);
    setActionError(null);
    setActionNotice(null);
    setExpandedTaskId(task.id);
    try {
      const run = await runNow(task.id, params);
      if (!run) setActionNotice(t('runQueued'));
      setRunDialogTask(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('errors.run'));
    } finally {
      setBusyTaskId(null);
    }
  };

  // Dialog submit: let the rejection reach the dialog so it can show the error
  // inline and stay open for a correction.
  const handleRunWithParams = async (task: ScheduledTask, params: Record<string, unknown>) => {
    setBusyTaskId(task.id);
    setActionError(null);
    setActionNotice(null);
    setExpandedTaskId(task.id);
    try {
      const run = await runNow(task.id, params);
      if (!run) setActionNotice(t('runQueued'));
      setRunDialogTask(null);
    } finally {
      setBusyTaskId(null);
    }
  };

  const handlePreview = async (task: ScheduledTask) => {
    setPreviewTarget(task);
    setPreviewResult(null);
    setPreviewError(null);
    setIsPreviewing(true);
    try {
      const result = await scheduledTasksApi.preview(task.id);
      setPreviewResult(result);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : t('errors.preview'));
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleRunRequest = (task: ScheduledTask) => {
    if (taskParams(task.params).length > 0) {
      setActionError(null);
      setRunDialogTask(task);
      return;
    }
    void handleRunNow(task);
  };

  const handleToggleHistory = (task: ScheduledTask) => {
    setExpandedTaskId((current) => (current === task.id ? null : task.id));
  };

  const handleSubmitEditor = async (values: TaskEditorValues) => {
    setActionError(null);
    if (editorTask) {
      await updateTask(editorTask.id, {
        title: values.title,
        prompt: values.prompt,
        projectPath: values.projectPath,
        model: values.model,
        command: values.command,
        commandTimeoutSeconds: values.commandTimeoutSeconds,
        enabled: values.enabled,
        rule: values.rule,
        params: values.params,
        conflictPolicy: values.conflictPolicy,
      });
    } else {
      const input: ScheduledTaskInput = {
        title: values.title,
        prompt: values.prompt,
        projectPath: values.projectPath,
        provider: 'claude',
        model: values.model,
        command: values.command,
        commandTimeoutSeconds: values.commandTimeoutSeconds,
        rule: values.rule,
        params: values.params,
        conflictPolicy: values.conflictPolicy,
      };
      await createTask(input);
    }
    setIsEditorOpen(false);
    setEditorTask(null);
  };

  const handleDeleteConfirm = async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    setActionError(null);
    const deletedId = pendingDelete.id;
    try {
      await deleteTask(deletedId);
      setPendingDelete(null);
      setExpandedTaskId((current) => (current === deletedId ? null : current));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('errors.delete'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopyConfirm = async (values: CopyTaskValues) => {
    if (!copyTarget) return;
    setIsCopying(true);
    setCopyError(null);
    try {
      await scheduledTasksApi.copy(copyTarget.id, values);
      setCopyTarget(null);
      await refresh();
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : t('errors.copy'));
    } finally {
      setIsCopying(false);
    }
  };

  const handleExport = async (task: ScheduledTask) => {
    setActionError(null);
    try {
      const envelope = await scheduledTasksApi.exportTask(task.id);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(task.title);
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('errors.export'));
    }
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setActionError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      const payload = (record && record.task ? record : { task: record }) as unknown as ImportTaskInput;
      await scheduledTasksApi.importTask(payload);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('errors.import'));
    }
  };

  const hasFilters = Boolean(search.trim()) || statusFilter !== 'all';

  const showEmptySearch = !isLoading && tasks.length === 0 && !error && hasFilters;
  const showEmpty = !isLoading && tasks.length === 0 && !error && !hasFilters;

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-4xl md:rounded-xl">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
            <RunningCountBadge count={runningCount} label={t('launcher.running', { count: runningCount })} />
            <div
              className="ml-2 flex items-center rounded-md border border-border p-0.5"
              role="tablist"
              aria-label={t('tabs.label')}
            >
              {PANEL_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                    activeTab === tab
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setActiveTab(tab)}
                >
                  {t('tabs.' + tab)}
                </button>
              ))}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('actions.close')}
            className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {activeTab === 'tasks' && (
          <div className="flex flex-shrink-0 flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchInput}
                aria-label={t('search.placeholder')}
                placeholder={t('search.placeholder')}
                className={cn(controlClassName, 'pl-8 pr-8')}
                onChange={(event) => setSearchInput(event.target.value)}
              />
              {searchInput && (
                <button
                  type="button"
                  aria-label={t('search.clear')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setSearchInput('')}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={tagInput}
                aria-label={t('tagFilter.placeholder')}
                placeholder={t('tagFilter.placeholder')}
                className={cn(controlClassName, 'w-32')}
                onChange={(event) => setTagInput(event.target.value)}
              />
              <div className="flex items-center rounded-md border border-border p-0.5" role="group" aria-label={t('filters.label')}>
                {STATUS_FILTERS.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    aria-pressed={statusFilter === filter}
                    className={cn(
                      'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                      statusFilter === filter
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => setStatusFilter(filter)}
                  >
                    {t('filters.' + filter)}
                  </button>
                ))}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
                aria-label={t('actions.refresh')}
                title={t('actions.refresh')}
                onClick={() => {
                  void refresh();
                }}
              >
                <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
              </Button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-label={t('actions.import')}
                onChange={(event) => {
                  void handleImportFile(event);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
                aria-label={t('actions.import')}
                title={t('actions.import')}
                onClick={() => importInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
              </Button>
              <Button type="button" size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4" />
                {t('actions.newTask')}
              </Button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {activeTab === 'presets' ? (
            <PresetsSection onTasksChanged={refresh} onOverlayChange={setIsPresetOverlayOpen} />
          ) : activeTab === 'calendar' ? (
            <UpcomingSection />
          ) : (
            <>
              {error && tasks.length === 0 && (
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

              {!error && isLoading && tasks.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('loading')}
                </div>
              )}

              {(showEmptySearch || showEmpty) && (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <Clock className="h-8 w-8 text-muted-foreground/50" />
                  <h3 className="text-sm font-medium text-foreground">
                    {showEmptySearch ? t('empty.searchTitle') : t('empty.title')}
                  </h3>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {showEmptySearch ? t('empty.searchDescription') : t('empty.description')}
                  </p>
                </div>
              )}

              {actionError && (
                <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{actionError}</p>
              )}
              {actionNotice && (
                <p className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">{actionNotice}</p>
              )}

              {tasks.length > 0 && (
                <div className="space-y-3">
                  {tasks.map((task) => (
                    <ScheduledTaskCard
                      key={task.id}
                      task={task}
                      isBusy={busyTaskId === task.id}
                      isExpanded={expandedTaskId === task.id}
                      onToggleEnabled={handleToggleEnabled}
                      onRunNow={handleRunRequest}
                      onEdit={openEdit}
                      onCopy={(task) => {
                        setCopyError(null);
                        setCopyTarget(task);
                      }}
                      onExport={(task) => {
                        void handleExport(task);
                      }}
                      onPreview={(task) => {
                        void handlePreview(task);
                      }}
                      onDelete={setPendingDelete}
                      onToggleHistory={handleToggleHistory}
                      onOpenSession={(sessionId) => {
                        onClose();
                        navigate('/session/' + sessionId);
                      }}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {isEditorOpen && (
        <TaskEditorDialog
          task={editorTask}
          onClose={() => {
            setIsEditorOpen(false);
            setEditorTask(null);
          }}
          onSubmit={handleSubmitEditor}
        />
      )}

      {runDialogTask ? (
        <RunWithParamsDialog
          task={runDialogTask}
          params={taskParams(runDialogTask.params)}
          onClose={() => setRunDialogTask(null)}
          onSubmit={(values) => handleRunWithParams(runDialogTask, values)}
        />
      ) : null}

      {copyTarget && (
        <CopyTaskDialog
          task={copyTarget}
          isBusy={isCopying}
          error={copyError}
          onClose={() => {
            setCopyTarget(null);
            setCopyError(null);
          }}
          onConfirm={(values) => {
            void handleCopyConfirm(values);
          }}
        />
      )}

      {previewTarget && (
        <PreviewDialog
          task={previewTarget}
          preview={previewResult}
          isLoading={isPreviewing}
          error={previewError}
          onClose={() => {
            setPreviewTarget(null);
            setPreviewResult(null);
            setPreviewError(null);
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t('confirmDelete.title')}
          description={t('confirmDelete.description', { title: pendingDelete.title })}
          confirmLabel={t('confirmDelete.confirm')}
          cancelLabel={t('actions.cancel')}
          isBusy={isDeleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void handleDeleteConfirm();
          }}
        />
      )}
    </div>,
    document.body,
  );
}
