import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Edit2, GitBranch, X } from 'lucide-react';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';
import { api } from '../../../../utils/api';

type MainContentTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
};

function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  return 'Project';
}

function getSessionTitle(session: ProjectSession): string {
  if (session.__provider === 'cursor') {
    return (session.name as string) || 'Untitled Session';
  }

  return (session.summary as string) || 'New Session';
}

function BranchBadge({ branch }: { branch?: string | null }) {
  if (!branch) return null;
  return (
    <span className="ml-1.5 inline-flex flex-shrink-0 items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
      <GitBranch className="h-3.5 w-3.5" />
      {branch}
    </span>
  );
}

export default function MainContentTitle({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
}: MainContentTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null);

  useEffect(() => {
    setOptimisticTitle(null);
  }, [selectedSession?.id]);

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const showChatNewSession = activeTab === 'chat' && !selectedSession;

  const startEditing = () => {
    if (!selectedSession) return;
    setEditValue(optimisticTitle ?? getSessionTitle(selectedSession));
    setIsEditing(true);
  };

  const saveTitle = async () => {
    if (!selectedSession) return;
    const trimmed = editValue.trim();
    setIsEditing(false);
    if (!trimmed || trimmed === (optimisticTitle ?? getSessionTitle(selectedSession))) return;
    setOptimisticTitle(trimmed);
    await api.renameSession(selectedSession.id, trimmed, selectedSession.__provider || 'claude');
    window.refreshProjects?.();
  };

  const cancelEditing = () => {
    setIsEditing(false);
  };

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <SessionProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {activeTab === 'chat' && selectedSession ? (
          <div className="flex min-w-0 flex-col gap-1">
            {isEditing ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { void saveTitle(); }
                    else if (e.key === 'Escape') { cancelEditing(); }
                  }}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                />
                <button
                  onClick={() => void saveTitle()}
                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-green-600 hover:text-green-700 transition-colors"
                  title="Save"
                  type="button"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={cancelEditing}
                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                  title="Cancel"
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="group/title flex items-center gap-1">
                <h2
                  className="scrollbar-hide overflow-x-auto whitespace-nowrap text-sm font-semibold leading-tight text-foreground cursor-pointer"
                  onClick={startEditing}
                  title="Click to rename"
                >
                  {optimisticTitle ?? getSessionTitle(selectedSession)}
                </h2>
                <button
                  onClick={startEditing}
                  className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded opacity-0 group-hover/title:opacity-100 text-muted-foreground/50 hover:text-muted-foreground transition-all"
                  title="Rename session"
                  type="button"
                >
                  <Edit2 className="h-3 w-3" />
                </button>
              </div>
            )}
            <div className="flex min-w-0 items-center text-sm leading-tight text-muted-foreground">
              <span className="truncate">{selectedProject.displayName}</span>
              <BranchBadge branch={selectedProject.currentBranch} />
            </div>
          </div>
        ) : showChatNewSession ? (
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-sm font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="flex min-w-0 items-center text-sm leading-tight text-muted-foreground">
              <span className="truncate">{selectedProject.displayName}</span>
              <BranchBadge branch={selectedProject.currentBranch} />
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
            </h2>
            <div className="flex min-w-0 items-center text-sm leading-tight text-muted-foreground">
              <span className="truncate">{selectedProject.displayName}</span>
              <BranchBadge branch={selectedProject.currentBranch} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
