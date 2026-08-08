import { memo, useEffect } from 'react';
import type { TFunction } from 'i18next';
import type { LoadingProgress, Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type {
  LoadingSessionsByProject,
  MCPServerStatus,
  SessionWithProvider,
} from '../../types/types';
import SidebarProjectItem from './SidebarProjectItem';
import SidebarProjectsState from './SidebarProjectsState';

// Memoize SidebarProjectItem so that unchanged projects bail out on every
// projects_updated broadcast (2-4x/second during active sessions).
// Primary guard: `project` reference equality — preserved by useProjectsState's
// stable-reference setProjects update for unchanged projects.
// Secondary guards: scalar props that drive selection/editing UI.
const SidebarProjectItemMemo = memo(SidebarProjectItem, (prev, next) =>
  prev.project === next.project &&
  prev.sessions.length === next.sessions.length &&
  prev.selectedProject?.name === next.selectedProject?.name &&
  prev.selectedSession?.id === next.selectedSession?.id &&
  prev.isExpanded === next.isExpanded &&
  prev.isDeleting === next.isDeleting &&
  prev.isStarred === next.isStarred &&
  prev.editingProject === next.editingProject &&
  prev.editingName === next.editingName &&
  prev.initialSessionsLoaded === next.initialSessionsLoaded &&
  prev.isLoadingSessions === next.isLoadingSessions &&
  prev.editingSession === next.editingSession &&
  prev.editingSessionName === next.editingSessionName &&
  prev.processingSessions === next.processingSessions &&
  prev.readSessionIds === next.readSessionIds &&
  prev.tasksEnabled === next.tasksEnabled,
);

export type SidebarProjectListProps = {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  expandedProjects: Set<string>;
  editingProject: string | null;
  editingName: string;
  loadingSessions: LoadingSessionsByProject;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  isProjectStarred: (projectName: string) => boolean;
  onEditingNameChange: (value: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: SessionProvider) => void;
  processingSessions?: Set<string>;
  processingSessionStartTimes?: ReadonlyMap<string, number>;
  readSessionIds?: Set<string>;
  t: TFunction;
};

export default function SidebarProjectList({
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  expandedProjects,
  editingProject,
  editingName,
  loadingSessions,
  initialSessionsLoaded,
  currentTime,
  editingSession,
  editingSessionName,
  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  isProjectStarred,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  processingSessions,
  readSessionIds,
  t,
}: SidebarProjectListProps) {
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    let baseTitle = 'CloudCLI UI';
    const displayName = selectedProject?.displayName?.trim();
    if (displayName) {
      baseTitle = `${displayName} - ${baseTitle}`;
    }
    document.title = baseTitle;
  }, [selectedProject]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  return (
    <div className="pb-safe-area-inset-bottom md:space-y-1">
      {!showProjects
        ? state
        : filteredProjects.map((project) => (
            <SidebarProjectItemMemo
              key={project.name}
              project={project}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              isExpanded={expandedProjects.has(project.name)}
              isDeleting={deletingProjects.has(project.name)}
              isStarred={isProjectStarred(project.name)}
              editingProject={editingProject}
              editingName={editingName}
              sessions={getProjectSessions(project)}
              initialSessionsLoaded={initialSessionsLoaded.has(project.name)}
              isLoadingSessions={Boolean(loadingSessions[project.name])}
              currentTime={currentTime}
              editingSession={editingSession}
              editingSessionName={editingSessionName}
              tasksEnabled={tasksEnabled}
              mcpServerStatus={mcpServerStatus}
              onEditingNameChange={onEditingNameChange}
              onToggleProject={onToggleProject}
              onProjectSelect={onProjectSelect}
              onToggleStarProject={onToggleStarProject}
              onStartEditingProject={onStartEditingProject}
              onCancelEditingProject={onCancelEditingProject}
              onSaveProjectName={onSaveProjectName}
              onDeleteProject={onDeleteProject}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              onLoadMoreSessions={onLoadMoreSessions}
              onNewSession={onNewSession}
              onEditingSessionNameChange={onEditingSessionNameChange}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              processingSessions={processingSessions}
              readSessionIds={readSessionIds}
              t={t}
            />
          ))}
    </div>
  );
}
