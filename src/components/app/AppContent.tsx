import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { PermissionToastContainer } from '../common/PermissionToastContainer';
import { useQuickSearch } from '../../hooks/useQuickSearch';
import QuickSearchOverlay from '../quick-search/QuickSearchOverlay';
import type { Project } from '../../types/app';

export default function AppContent() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, latestMessage, isConnected } = useWebSocket();
  const wasConnectedRef = useRef(false);
  const { isOpen: isSearchOpen, close: closeSearch } = useQuickSearch();

  const {
    activeSessions,
    processingSessions,
    processingSessionsMap,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    batchMarkSessionsAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  } = useSessionProtection();

  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    newSessionToken,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleSessionSelect,
    handleProjectSelect,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });

  const [scrollToProjectToken, setScrollToProjectToken] = useState(0);
  const [scrollToProjectName, setScrollToProjectName] = useState<string | null>(null);

  const handleProjectSelectWithScroll = useCallback((project: Project) => {
    handleProjectSelect(project);
    setScrollToProjectName(project.name);
    setScrollToProjectToken(prev => prev + 1);
  }, [handleProjectSelect]);

  useEffect(() => {
    // Expose a non-blocking refresh for chat/session flows.
    // Full loading refreshes are still available through direct fetchProjects calls.
    window.refreshProjects = refreshProjectsSilently;

    return () => {
      if (window.refreshProjects === refreshProjectsSilently) {
        delete window.refreshProjects;
      }
    };
  }, [refreshProjectsSilently]);

  useEffect(() => {
    window.openSettings = openSettings;

    return () => {
      if (window.openSettings === openSettings) {
        delete window.openSettings;
      }
    };
  }, [openSettings]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // On connect/reconnect: discover already-running sessions.
  useEffect(() => {
    if (!isConnected) { wasConnectedRef.current = false; return; }
    wasConnectedRef.current = true;
    sendMessage({ type: 'get-active-sessions' });
  }, [isConnected, sendMessage]);

  // Permission recovery: query pending permissions on session change or reconnect.
  useEffect(() => {
    if (isConnected && selectedSession?.id) {
      sendMessage({
        type: 'get-pending-permissions',
        sessionId: selectedSession.id
      });
    }
  }, [isConnected, selectedSession?.id, sendMessage]);

  useEffect(() => {
    if (!latestMessage || latestMessage.type !== 'active-sessions') return;
    const sessions = latestMessage.sessions as Record<string, string[]> | undefined;
    if (!sessions) return;
    const entries: Array<{ sessionId: string; provider: string }> = [];
    for (const [provider, ids] of Object.entries(sessions)) {
      if (!Array.isArray(ids)) continue;
      for (const sessionId of ids) {
        if (sessionId) entries.push({ sessionId, provider });
      }
    }
    if (entries.length > 0) batchMarkSessionsAsProcessing(entries);
  }, [latestMessage, batchMarkSessionsAsProcessing]);

  // Poll backend every 5s for any session stuck in isProcessing state
  useEffect(() => {
    if (processingSessionsMap.size === 0) return;

    const interval = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const sessions = Array.from(processingSessionsMap.entries()).map(([sessionId, provider]) => ({ sessionId, provider }));
      sendMessage({ type: 'check-sessions-status', sessions });
    }, 5_000);

    return () => clearInterval(interval);
  }, [processingSessionsMap, sendMessage, ws]);

  return (
    <div className="fixed inset-0 flex bg-background">
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar {...sidebarSharedProps} onProjectSelect={handleProjectSelectWithScroll} processingSessions={processingSessions} scrollToProjectToken={scrollToProjectToken} scrollToProjectName={scrollToProjectName} />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarSharedProps} onProjectSelect={handleProjectSelectWithScroll} processingSessions={processingSessions} scrollToProjectToken={scrollToProjectToken} scrollToProjectName={scrollToProjectName} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionActive={markSessionAsActive}
          onSessionInactive={markSessionAsInactive}
          onSessionProcessing={markSessionAsProcessing}
          onSessionNotProcessing={markSessionAsNotProcessing}
          processingSessions={processingSessions}
          onReplaceTemporarySession={replaceTemporarySession}
          onNavigateToSession={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
          onShowSettings={() => setShowSettings(true)}
          allProjects={projects}
          newSessionToken={newSessionToken}
        />
      </div>

      <PermissionToastContainer
        selectedSessionId={selectedSession?.id}
        getSessionName={(id) => {
          const session = projects
            .flatMap((p) => [
              ...(p.sessions ?? []),
              ...(p.cursorSessions ?? []),
              ...(p.codexSessions ?? []),
              ...(p.geminiSessions ?? []),
            ])
            .find((s) => s.id === id);
          return session?.title ?? id;
        }}
        onNavigate={(sessionId) => {
          const session = projects
            .flatMap((p) => [
              ...(p.sessions ?? []),
              ...(p.cursorSessions ?? []),
              ...(p.codexSessions ?? []),
              ...(p.geminiSessions ?? []),
            ])
            .find((s) => s.id === sessionId);
          if (!session) {
            console.warn('[PermissionToastContainer] onNavigate: session not found for id', sessionId);
            return;
          }
          handleSessionSelect(session);
        }}
      />

      {isSearchOpen && (
        <QuickSearchOverlay
          projects={projects}
          onSessionSelect={(session) => {
            handleSessionSelect(session);
          }}
          onProjectSelect={handleProjectSelectWithScroll}
          onClose={closeSearch}
        />
      )}
    </div>
  );
}
