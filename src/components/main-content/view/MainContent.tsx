import React, { useCallback, useEffect } from 'react';
import ChatInterface from '../../chat/view/ChatInterface';
import ShellSessionPool from '../../shell-pool/ShellSessionPool';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import type { Project } from '../../../types/app';
import type { CodeEditorDiffInfo } from '../../code-editor/types/types';
import { TaskMasterPanel } from '../../task-master';
import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import { useChatRightPanel } from '../../../hooks/useChatRightPanel';
import RightPanel from '../../right-panel/RightPanel';
import ResizeHandle from '../../right-panel/ResizeHandle';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  allProjects = [],
  newSessionToken,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, showSubAgentInput, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  const {
    state: rightPanelState,
    toggle: toggleRightPanel,
    setActiveTab: setRightPanelTab,
    close: closeRightPanel,
    adjustWidth: adjustRightPanelWidth,
    openFile: openRightPanelFile,
    closeFile: closeRightPanelFile,
    toggleEditorExpand: toggleRightPanelEditorExpand,
  } = useChatRightPanel();

  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
      openRightPanelFile(filePath, diffInfo, selectedProject?.name);
    },
    [openRightPanelFile, selectedProject?.name],
  );

  const handleRightPanelResize = useCallback(
    (delta: number) => adjustRightPanelWidth(delta),
    [adjustRightPanelWidth],
  );

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  const { editorExpanded } = rightPanelState;

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onToggleFiles={() => toggleRightPanel('files')}
        onToggleGit={() => toggleRightPanel('git')}
        rightPanelOpen={rightPanelState.open}
        rightPanelActiveTab={rightPanelState.activeTab}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''}`}
          style={
            rightPanelState.open && !editorExpanded
              ? { width: `calc(100% - ${rightPanelState.width + 6}px)`, flex: 'none' }
              : { flex: '1' }
          }
        >
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                latestMessage={latestMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionActive={onSessionActive}
                onSessionInactive={onSessionInactive}
                onSessionProcessing={onSessionProcessing}
                onSessionNotProcessing={onSessionNotProcessing}
                processingSessions={processingSessions}
                onReplaceTemporarySession={onReplaceTemporarySession}
                onNavigateToSession={onNavigateToSession}
                onShowSettings={onShowSettings}
                allProjects={allProjects}
                newSessionToken={newSessionToken}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                showSubAgentInput={showSubAgentInput}
                autoScrollToBottom={autoScrollToBottom}
                sendByCtrlEnter={sendByCtrlEnter}
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              />
            </ErrorBoundary>
          </div>

          <div className={`h-full w-full overflow-hidden ${activeTab === 'shell' ? 'block' : 'hidden'}`}>
            <ShellSessionPool
              project={selectedProject}
              activeSession={selectedSession}
              isActive={activeTab === 'shell'}
            />
          </div>

          {shouldShowTasksTab && <TaskMasterPanel isVisible={activeTab === 'tasks'} />}

          <div className={`h-full overflow-hidden ${activeTab === 'preview' ? 'block' : 'hidden'}`} />

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        {/* Right panel (Git / Files / Editor) */}
        {rightPanelState.open && (
          <>
            {!editorExpanded && (
              <ResizeHandle onResize={handleRightPanelResize} />
            )}
            <div
              style={editorExpanded ? undefined : { width: rightPanelState.width, flexShrink: 0 }}
              className={`flex min-h-0 flex-col overflow-hidden ${editorExpanded ? 'flex-1' : ''}`}
            >
              <RightPanel
                activeTab={rightPanelState.activeTab}
                onTabChange={setRightPanelTab}
                onClose={closeRightPanel}
                selectedProject={selectedProject}
                onFileOpen={handleFileOpen}
                editingFile={rightPanelState.editingFile}
                editorExpanded={editorExpanded}
                onCloseFile={closeRightPanelFile}
                onToggleEditorExpand={toggleRightPanelEditorExpand}
                isMobile={isMobile}
                projectPath={selectedProject.path}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
