import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { api } from '../utils/api';
import { logger } from '../utils/logger';
import type {
  AppSocketMessage,
  AppTab,
  LoadingProgress,
  Project,
  ProjectSession,
  ProjectsUpdatedMessage,
  SessionProvider,
} from '../types/app';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  latestMessage: AppSocketMessage | null;
  isMobile: boolean;
  activeSessions: Set<string>;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

const serialize = (value: unknown) => JSON.stringify(value ?? null);

export const projectHasChanges = (
  prevProject: Project,
  nextProject: Project,
  includeExternalSessions: boolean,
): boolean => {
  const baseChanged =
    nextProject.name !== prevProject.name ||
    nextProject.displayName !== prevProject.displayName ||
    nextProject.fullPath !== prevProject.fullPath ||
    serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
    serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
    serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster);

  if (baseChanged) {
    return true;
  }

  if (!includeExternalSessions) {
    return false;
  }

  return (
    serialize(nextProject.cursorSessions) !== serialize(prevProject.cursorSessions) ||
    serialize(nextProject.codexSessions) !== serialize(prevProject.codexSessions) ||
    serialize(nextProject.geminiSessions) !== serialize(prevProject.geminiSessions) ||
    serialize(nextProject.copilotSessions) !== serialize(prevProject.copilotSessions)
  );
};

export const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
  includeExternalSessions: boolean,
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }
    return projectHasChanges(prevProject, nextProject, includeExternalSessions);
  });
};

/**
 * Rebuild the projects array from a `projects_updated` payload, reusing unchanged
 * project/session object references so React.memo can bail out cheaply.
 *
 * Must stay consistent with `projectsHaveChanges`: when that guard reports a change,
 * the rebuilt array must actually differ in content. If it doesn't, the guard keeps
 * allocating a fresh array on every pass, re-triggering the projects_updated effect
 * until React throws "Maximum update depth exceeded".
 */
export const mergeProjects = (
  prevProjects: Project[],
  updatedProjects: Project[],
): Project[] => {
  if (prevProjects.length === 0) {
    return updatedProjects;
  }
  if (!projectsHaveChanges(prevProjects, updatedProjects, true)) {
    return prevProjects;
  }

  return updatedProjects.map((nextProject) => {
    const prevProject = prevProjects.find((p) => p.name === nextProject.name);
    if (!prevProject) {
      return nextProject;
    }
    // Same predicate as the guard above — never return a stale object for a changed project.
    if (!projectHasChanges(prevProject, nextProject, true)) {
      return prevProject;
    }
    // Project changed — but preserve stable refs for individual sessions that didn't change,
    // so React.memo on SidebarSessionItem can bail out for the untouched sessions.
    if (nextProject.sessions && prevProject.sessions) {
      const prevSessionMap = new Map(prevProject.sessions.map((s) => [s.id, s]));
      const stableSessions = nextProject.sessions.map((nextSess) => {
        const prevSess = prevSessionMap.get(nextSess.id);
        // Full content compare, so the rebuilt array still serializes equal to
        // nextProject.sessions and the guard converges on the next pass.
        if (prevSess && serialize(prevSess) === serialize(nextSess)) {
          return prevSess;
        }
        return nextSess;
      });
      return { ...nextProject, sessions: stableSessions };
    }
    return nextProject;
  });
};

export const mergeSelectedSessionMetadata = (
  selectedSession: ProjectSession | null,
  latestSession: ProjectSession,
  provider: SessionProvider,
): ProjectSession => {
  const merged = {
    ...(selectedSession?.id === latestSession.id ? selectedSession : null),
    ...latestSession,
    __provider: provider,
  };

  return selectedSession && serialize(merged) === serialize(selectedSession)
    ? selectedSession
    : merged;
};

const getProjectSessions = (project: Project): ProjectSession[] => {
  return [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
    ...(project.cursorSessions ?? []),
    ...(project.geminiSessions ?? []),
    ...(project.copilotSessions ?? []),
  ];
};

const isUpdateAdditive = (
  currentProjects: Project[],
  updatedProjects: Project[],
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): boolean => {
  if (!selectedProject || !selectedSession) {
    return true;
  }

  const currentSelectedProject = currentProjects.find((project) => project.name === selectedProject.name);
  const updatedSelectedProject = updatedProjects.find((project) => project.name === selectedProject.name);

  if (!currentSelectedProject || !updatedSelectedProject) {
    return false;
  }

  const currentSelectedSession = getProjectSessions(currentSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );
  const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );

  if (!currentSelectedSession || !updatedSelectedSession) {
    return false;
  }

  return (
    currentSelectedSession.id === updatedSelectedSession.id &&
    currentSelectedSession.title === updatedSelectedSession.title &&
    currentSelectedSession.created_at === updatedSelectedSession.created_at &&
    currentSelectedSession.updated_at === updatedSelectedSession.updated_at
  );
};

const VALID_TABS: Set<string> = new Set(['chat', 'shell', 'tasks', 'preview']);

const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab) || tab.startsWith('plugin:');
};

const readPersistedTab = (): AppTab => {
  try {
    const stored = localStorage.getItem('activeTab');
    if (stored && isValidTab(stored)) {
      return stored as AppTab;
    }
  } catch {
    // localStorage unavailable
  }
  return 'chat';
};

/** Read the last-used chat/shell tab for a specific session. Defaults to 'chat'. */
const getSessionTab = (sessionId: string | null | undefined): AppTab => {
  if (!sessionId) return 'chat';
  try {
    const stored = localStorage.getItem(`session-tab:${sessionId}`);
    if (stored === 'chat' || stored === 'shell') return stored;
  } catch {
    // localStorage unavailable
  }
  return 'chat';
};

/** Persist the active tab for a session. Only chat/shell are stored. */
const saveSessionTab = (sessionId: string | null | undefined, tab: AppTab): void => {
  if (!sessionId || (tab !== 'chat' && tab !== 'shell')) return;
  try {
    localStorage.setItem(`session-tab:${sessionId}`, tab);
  } catch {
    // Silently ignore storage errors
  }
};

export function useProjectsState({
  sessionId,
  navigate,
  latestMessage,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);
  const [newSessionToken, setNewSessionToken] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem('activeTab', activeTab);
      saveSessionTab(selectedSession?.id, activeTab);
    } catch {
      // Silently ignore storage errors
    }
  }, [activeTab, selectedSession?.id]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}): Promise<Project[] | undefined> => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects({ silent: !showLoadingState });
      const projectData = (await response.json()) as Project[];

      setProjects((prevProjects) => {
        if (prevProjects.length === 0) {
          return projectData;
        }

        return projectsHaveChanges(prevProjects, projectData, true)
          ? projectData
          : prevProjects;
      });

      return projectData;
    } catch (error) {
      logger.error('Error fetching projects:', error);
      return undefined;
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  useEffect(() => {
    if (!latestMessage) {
      return;
    }

    if (latestMessage.type === 'loading_progress') {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }

      setLoadingProgress(latestMessage as LoadingProgress);

      if (latestMessage.phase === 'complete') {
        loadingProgressTimeoutRef.current = setTimeout(() => {
          setLoadingProgress(null);
          loadingProgressTimeoutRef.current = null;
        }, 500);
      }

      return;
    }

    if (latestMessage.type !== 'projects_updated') {
      return;
    }

    const projectsMessage = latestMessage as ProjectsUpdatedMessage;

    if (projectsMessage.changedFile && selectedSession && selectedProject) {
      const normalized = projectsMessage.changedFile.replace(/\\/g, '/');
      const changedFileParts = normalized.split('/');

      if (changedFileParts.length >= 2) {
        const filename = changedFileParts[changedFileParts.length - 1];
        const changedSessionId = filename.replace('.jsonl', '');

        logger.log('[projects_updated] changedFile=%s changedSessionId=%s currentSession=%s match=%s',
          filename, changedSessionId.slice(0, 8), selectedSession.id.slice(0, 8), changedSessionId === selectedSession.id);

        if (changedSessionId === selectedSession.id) {
          const isSessionActive = activeSessions.has(selectedSession.id);
          if (isSessionActive) {
            logger.log('[projects_updated] → skip (session is active/streaming, WS handles it)');
          }
          // New messages (if any) are delivered via projects_updated.newMessages → useChatRealtimeHandlers
        }
      }
    }

    const hasActiveSession =
      (selectedSession && activeSessions.has(selectedSession.id)) ||
      (activeSessions.size > 0 && Array.from(activeSessions).some((id) => id.startsWith('new-session-')));

    const updatedProjects = projectsMessage.projects;

    if (
      hasActiveSession &&
      !isUpdateAdditive(projects, updatedProjects, selectedProject, selectedSession)
    ) {
      return;
    }

    setProjects((prevProjects) => mergeProjects(prevProjects, updatedProjects));

    if (!selectedProject) {
      return;
    }

    const updatedSelectedProject = updatedProjects.find(
      (project) => project.name === selectedProject.name,
    );

    if (!updatedSelectedProject) {
      return;
    }

    if (serialize(updatedSelectedProject) !== serialize(selectedProject)) {
      logger.log('[projects_updated] → setSelectedProject changed fields:', {
        name: updatedSelectedProject.name !== selectedProject.name ? `${selectedProject.name}→${updatedSelectedProject.name}` : 'same',
        sessions: updatedSelectedProject.sessions?.length !== selectedProject.sessions?.length
          ? `${selectedProject.sessions?.length}→${updatedSelectedProject.sessions?.length}`
          : 'same count',
        fullPath: updatedSelectedProject.fullPath !== selectedProject.fullPath ? 'changed' : 'same',
      });
      setSelectedProject(updatedSelectedProject);
    } else {
      logger.log('[projects_updated] → skip setSelectedProject (no change)');
    }

    // Do NOT update or clear selectedSession from projects_updated —
    // the sessions list in projects_updated is paginated and may not include the
    // currently-viewed session.  Clearing it triggers a cascade: URL-effect re-runs →
    // may pick a different project → mainEffect re-fetches with wrong projectName → data clears.
  }, [latestMessage, selectedProject, activeSessions, projects]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    for (const project of projects) {
      const claudeSession = project.sessions?.find((session) => session.id === sessionId);
      if (claudeSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const nextSelectedSession = mergeSelectedSessionMetadata(selectedSession, claudeSession, 'claude');

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (nextSelectedSession !== selectedSession) {
          setSelectedSession(nextSelectedSession);
        }
        return;
      }

      const cursorSession = project.cursorSessions?.find((session) => session.id === sessionId);
      if (cursorSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const nextSelectedSession = mergeSelectedSessionMetadata(selectedSession, cursorSession, 'cursor');

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (nextSelectedSession !== selectedSession) {
          setSelectedSession(nextSelectedSession);
        }
        return;
      }

      const codexSession = project.codexSessions?.find((session) => session.id === sessionId);
      if (codexSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const nextSelectedSession = mergeSelectedSessionMetadata(selectedSession, codexSession, 'codex');

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (nextSelectedSession !== selectedSession) {
          setSelectedSession(nextSelectedSession);
        }
        return;
      }

      const geminiSession = project.geminiSessions?.find((session) => session.id === sessionId);
      if (geminiSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const nextSelectedSession = mergeSelectedSessionMetadata(selectedSession, geminiSession, 'gemini');

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (nextSelectedSession !== selectedSession) {
          setSelectedSession(nextSelectedSession);
        }
        return;
      }

      const copilotSession = project.copilotSessions?.find((session) => session.id === sessionId);
      if (copilotSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const nextSelectedSession = mergeSelectedSessionMetadata(selectedSession, copilotSession, 'copilot');

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (nextSelectedSession !== selectedSession) {
          setSelectedSession(nextSelectedSession);
        }
        return;
      }
    }
  }, [sessionId, projects, selectedProject?.name, selectedSession?.id, selectedSession?.__provider]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      // If the session comes from a different project (e.g. Recent list), update
      // selectedProject first so that the chat mainEffect fires with the correct
      // project and doesn't request token-usage / messages for the wrong project.
      if (session.__projectName && session.__projectName !== selectedProject?.name) {
        const matchingProject = projects.find((p) => p.name === session.__projectName);
        if (matchingProject) {
          setSelectedProject(matchingProject);
        }
      }

      setSelectedSession(session);

      setActiveTab(getSessionTab(session.id));

      const provider = localStorage.getItem('selected-provider') || 'claude';
      if (provider === 'cursor') {
        sessionStorage.setItem('cursorSessionId', session.id);
      }

      if (isMobile) {
        setSidebarOpen(false);
      }

      navigate(`/session/${session.id}`);
    },
    [isMobile, navigate, projects, selectedProject?.name],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      setNewSessionToken(t => t + 1);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => ({
          ...project,
          sessions: project.sessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          codexSessions: project.codexSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          cursorSessions: project.cursorSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          geminiSessions: project.geminiSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          copilotSessions: project.copilotSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          sessionMeta: {
            ...project.sessionMeta,
            total: Math.max(0, (project.sessionMeta?.total as number | undefined ?? 0) - 1),
          },
        })),
      );
    },
    [navigate, selectedSession?.id],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const freshProjects = await fetchProjects({ showLoadingState: true });
      if (!freshProjects) {
        return;
      }

      if (!selectedProject) {
        return;
      }

      const refreshedProject = freshProjects.find((project) => project.name === selectedProject.name);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession =
          refreshedSession.__provider || !selectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: selectedSession.__provider };

        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      logger.error('Error refreshing sidebar:', error);
    }
  }, [fetchProjects, selectedProject, selectedSession]);

  const handleProjectDelete = useCallback(
    (projectName: string) => {
      if (selectedProject?.name === projectName) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.name !== projectName));
    },
    [navigate, selectedProject?.name],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      projects,
      settingsInitialTab,
      selectedProject,
      selectedSession,
      showSettings,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    newSessionToken,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    handleProjectDelete,
    handleSidebarRefresh,
  };
}
