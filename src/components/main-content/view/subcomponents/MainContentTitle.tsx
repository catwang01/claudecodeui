import { useTranslation } from 'react-i18next';
import { GitBranch } from 'lucide-react';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';

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

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const showChatNewSession = activeTab === 'chat' && !selectedSession;

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
            <h2 className="scrollbar-hide overflow-x-auto whitespace-nowrap text-sm font-semibold leading-tight text-foreground">
              {getSessionTitle(selectedSession)}
            </h2>
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
