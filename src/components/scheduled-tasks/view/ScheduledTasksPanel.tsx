import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Clock, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useScheduledTasks } from '../hooks/useScheduledTasks';
import type { ScheduledTask, ScheduledTaskInput, TaskStatusFilter } from '../types';
import ConfirmDialog from './ConfirmDialog';
import { controlClassName } from './FormControls';
import PresetsSection from './PresetsSection';
import ScheduledTaskCard from './ScheduledTaskCard';
import TaskEditorDialog from './TaskEditorDialog';
import type { TaskEditorValues } from './TaskEditorDialog';

type ScheduledTasksPanelProps = {
  onClose: () => void;
};

type PanelTab = 'tasks' | 'presets';

const STATUS_FILTERS: TaskStatusFilter[] = ['all', 'enabled', 'paused'];
const PANEL_TABS: PanelTab[] = ['tasks', 'presets'];

export default function ScheduledTasksPanel({ onClose }: ScheduledTasksPanelProps) {
  const { t } = useTranslation('scheduledTasks');
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<PanelTab>('tasks');
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 250);
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>('all');
  const { tasks, isLoading, error, refresh, createTask, updateTask, deleteTask, runNow } = useScheduledTasks({
    status: statusFilter,
    search,
  });

  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editorTask, setEditorTask] = useState<ScheduledTask | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledTask | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // Presets own their dialogs; this only stops Escape from closing the panel behind them.
  const [isPresetOverlayOpen, setIsPresetOverlayOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isEditorOpen && !pendingDelete && !isPresetOverlayOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isEditorOpen, pendingDelete, isPresetOverlayOpen]);

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

  const handleRunNow = async (task: ScheduledTask) => {
    setBusyTaskId(task.id);
    setActionError(null);
    setExpandedTaskId(task.id);
    try {
      await runNow(task.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('errors.run'));
    } finally {
      setBusyTaskId(null);
    }
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

              {tasks.length > 0 && (
                <div className="space-y-3">
                  {actionError && (
                    <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{actionError}</p>
                  )}
                  {tasks.map((task) => (
                    <ScheduledTaskCard
                      key={task.id}
                      task={task}
                      isBusy={busyTaskId === task.id}
                      isExpanded={expandedTaskId === task.id}
                      onToggleEnabled={handleToggleEnabled}
                      onRunNow={handleRunNow}
                      onEdit={openEdit}
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
