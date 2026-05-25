import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatInterfaceProps, Provider  } from '../types/types';
import type { SessionProvider } from '../../../types/app';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { CLAUDE_MODELS, CURSOR_MODELS, CODEX_MODELS, GEMINI_MODELS } from '../../../../shared/modelConstants';
import { useSessionStore } from '../../../stores/useSessionStore';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { api } from '../../../utils/api';
import { useTTS } from '../../../hooks/useTTS';
import { useVoiceConversation } from '../../../contexts/VoiceConversationContext';
import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import { NewSessionLoadingModal } from './NewSessionLoadingModal';


type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  latestMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  showSubAgentInput,
  autoScrollToBottom,
  sendByCtrlEnter,
  onShowAllTasks,
  allProjects = [],
  newSessionToken,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { t } = useTranslation('chat');
  const { isConnected } = useWebSocket();

  const sessionStore = useSessionStore();
  const { speak } = useTTS();
  const { registerSubmitCallback, notifyLoadingChange, status: voiceStatus, transcript: voiceTranscript, toggle: toggleVoice, isActive: isVoiceActive, supported: isVoiceSupported } = useVoiceConversation();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamMapRef = useRef<Map<string, string>>(new Map());
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamMapRef.current.clear();
  }, []);

  const [isForkingSession, setIsForkingSession] = useState(false);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    geminiModel,
    setGeminiModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  } = useChatProviderState({
    selectedSession,
  });

  const {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    loadingStartTime,
    setSessionStartTime,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    flushPendingMessageToSession,
    pendingUserMessage,
    isCreatingSession,
    sessionCreationError,
    setSessionCreationError,
    clearSessionCreation,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    isConnected,
    sendMessage,
    autoScrollToBottom,
    processingSessions,
    resetStreamingState,
    pendingViewSessionRef,
    sessionStore,
    newSessionToken,
  });

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    thinkingMode,
    setThinkingMode,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    imageInputRef,
    handleImageFiles,
    attachedFiles,
    uploadError,
    setUploadError,
    fileInputRef,
    openFilePicker,
    handleFileInputChange,
    handleRemoveFile,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    submitVoiceInput,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    cursorModel,
    claudeModel,
    codexModel,
    geminiModel,
    isLoading,
    canAbortSession,
    tokenBudget,
    sendMessage,
    isConnected,
    sendByCtrlEnter,
    onSessionActive,
    onSessionProcessing,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    pendingViewSessionRef,
    scrollToBottom,
    addMessage,
    clearMessages,
    rewindMessages,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    allProjects,
  });

  // On WebSocket reconnect, re-fetch the current session's messages from the server
  // so missed streaming events are shown. Also reset isLoading.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    const providerVal = (selectedSession.__provider || (localStorage.getItem('selected-provider') as SessionProvider)) || 'claude';
    const currentSlot = sessionStore.getSessionSlot(selectedSession.id);
    const currentCount = currentSlot?.messages.length ?? 0;
    await sessionStore.refreshFromServer(selectedSession.id, {
      provider: providerVal as SessionProvider,
      projectName: selectedProject.name,
      projectPath: selectedProject.fullPath || selectedProject.path || '',
      limit: currentCount > 0 ? Math.max(20, currentCount) : undefined,
    });
    // Clear processing state optimistically so the processingSessions effect doesn't
    // fight setIsLoading(false). check-session-status will restore loading state if
    // the session is still actually running on the backend.
    onSessionNotProcessing?.(selectedSession.id);
    setIsLoading(false);
    setCanAbortSession(false);
    setClaudeStatus(null);
    if (ws) {
      sendMessage({ type: 'check-session-status', sessionId: selectedSession.id, provider: providerVal });
    }
  }, [selectedProject, selectedSession, sessionStore, onSessionNotProcessing, setIsLoading, setCanAbortSession, setClaudeStatus, ws, sendMessage]);

  const handleForkAtMessage = useCallback(async (timestamp: string) => {
    if (!selectedProject || !selectedSession) return;
    setIsForkingSession(true);
    try {
      const result = await api.forkSession(selectedProject.name, selectedSession.id, timestamp);
      if (result.newSessionId) {
        // Refresh the sidebar session list so the fork appears
        window.refreshProjects?.();
        onNavigateToSession?.(result.newSessionId);
      }
    } finally {
      setIsForkingSession(false);
    }
  }, [selectedProject, selectedSession, onNavigateToSession]);

  const handleSessionCreationRetry = useCallback(() => {
    if (pendingUserMessage?.content) {
      setInput(pendingUserMessage.content);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        textareaRef.current.focus();
      }
    }
    clearSessionCreation();
  }, [clearSessionCreation, pendingUserMessage, setInput, textareaRef]);

  // When the server reports a session is processing, override the local Date.now() estimate
  // with the server-recorded startTime so the timer is accurate even after page reload.
  const handleSessionProcessing = useCallback((sessionId?: string | null, provider?: string, startTime?: number | null) => {
    const activeId = selectedSession?.id || currentSessionId;
    if (sessionId && startTime && sessionId === activeId) {
      setSessionStartTime(sessionId, startTime);
    }
    onSessionProcessing?.(sessionId, provider);
  }, [onSessionProcessing, setSessionStartTime, selectedSession?.id, currentSessionId]);

  useChatRealtimeHandlers({
    latestMessage,
    provider,
    selectedProject,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    streamTimerRef,
    accumulatedStreamMapRef,
    onSessionInactive,
    onSessionProcessing: handleSessionProcessing,
    onSessionNotProcessing,
    onPreSessionCreated: flushPendingMessageToSession,
    onReplaceTemporarySession,
    onNavigateToSession,
    onWebSocketReconnect: handleWebSocketReconnect,
    onAssistantSpeech: speak,
    onSessionCreationError: setSessionCreationError,
    sessionStore,
  });

  // Register voice submit callback
  useEffect(() => {
    registerSubmitCallback(submitVoiceInput);
  }, [registerSubmitCallback, submitVoiceInput]);

  // Notify voice context of loading state changes
  useEffect(() => {
    notifyLoadingChange(isLoading);
  }, [isLoading, notifyLoadingChange]);

  // Show interim voice transcript in the textarea while listening
  useEffect(() => {
    if (voiceStatus === 'listening') {
      setInput(voiceTranscript);
    }
  }, [voiceStatus, voiceTranscript, setInput]);

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isLoading]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  useEffect(() => {
    if (!uploadError) return;
    const timer = setTimeout(() => setUploadError(null), 4000);
    return () => clearTimeout(timer);
  }, [uploadError, setUploadError]);

  if (!selectedProject) {
    const selectedProviderLabel =
      provider === 'cursor'
        ? t('messageTypes.cursor')
        : provider === 'codex'
          ? t('messageTypes.codex')
          : provider === 'gemini'
            ? t('messageTypes.gemini')
            : t('messageTypes.claude');

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div {...getRootProps()} className="relative flex h-full flex-col">
        <input {...getInputProps()} />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) handleImageFiles(files);
            e.target.value = '';
          }}
        />
        {isDragActive && (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/10 backdrop-blur-[2px]">
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border/40 bg-card/90 px-8 py-6 shadow-xl">
              <svg className="h-10 w-10 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-sm font-medium text-foreground">松开以上传文件</p>
            </div>
          </div>
        )}
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          geminiModel={geminiModel}
          setGeminiModel={setGeminiModel}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          showSubAgentInput={showSubAgentInput}
          selectedProject={selectedProject}
          isLoading={isLoading}
          onForkAtMessage={handleForkAtMessage}
        />

        <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          claudeStatus={claudeStatus}
          isLoading={isLoading}
          loadingStartTime={loadingStartTime}
          isConnected={isConnected}
          onAbortSession={handleAbortSession}
          provider={provider}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          thinkingMode={thinkingMode}
          setThinkingMode={setThinkingMode}
          tokenBudget={tokenBudget}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={chatMessages.length > 0}
          onScrollToBottom={scrollToBottomAndReset}
          onSubmit={handleSubmit}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          openImagePicker={openImagePicker}
          attachedFiles={attachedFiles}
          onRemoveFile={handleRemoveFile}
          fileInputRef={fileInputRef}
          onFileInputChange={handleFileInputChange}
          openFilePicker={openFilePicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          isInputFocused={isInputFocused}
          placeholder={t('input.placeholder', {
            provider:
              provider === 'cursor'
                ? t('messageTypes.cursor')
                : provider === 'codex'
                  ? t('messageTypes.codex')
                  : provider === 'gemini'
                    ? t('messageTypes.gemini')
                    : t('messageTypes.claude'),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          voiceStatus={voiceStatus}
          isVoiceActive={isVoiceActive}
          isVoiceSupported={isVoiceSupported}
          onVoiceToggle={toggleVoice}
          sessionId={selectedSession?.id ?? null}
          sessionTitle={selectedSession?.title ?? selectedSession?.summary ?? null}
          currentModel={
            provider === 'claude' ? claudeModel :
            provider === 'cursor' ? cursorModel :
            provider === 'codex' ? codexModel : geminiModel
          }
          modelOptions={
            provider === 'claude' ? CLAUDE_MODELS.OPTIONS :
            provider === 'cursor' ? CURSOR_MODELS.OPTIONS :
            provider === 'codex' ? CODEX_MODELS.OPTIONS : GEMINI_MODELS.OPTIONS
          }
          onModelChange={(value) => {
            if (provider === 'claude') { setClaudeModel(value); localStorage.setItem('claude-model', value); }
            else if (provider === 'cursor') { setCursorModel(value); localStorage.setItem('cursor-model', value); }
            else if (provider === 'codex') { setCodexModel(value); localStorage.setItem('codex-model', value); }
            else { setGeminiModel(value); localStorage.setItem('gemini-model', value); }
          }}
        />
      </div>

      <QuickSettingsPanel />

      {isForkingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative flex flex-col items-center gap-4 rounded-xl border border-border bg-card px-10 py-8 shadow-2xl">
            <svg className="h-8 w-8 animate-spin text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <p className="text-sm font-medium text-foreground">{t('session.fork.forking')}</p>
          </div>
        </div>
      )}

      <NewSessionLoadingModal
        isVisible={isCreatingSession}
        error={sessionCreationError}
        onRetry={handleSessionCreationRetry}
        onCancel={clearSessionCreation}
      />

      {uploadError && (
        <div className="fixed bottom-28 left-1/2 z-[9999] -translate-x-1/2 animate-in slide-in-from-bottom-2 fade-in duration-200">
          <div className="flex items-center gap-2 rounded-lg bg-destructive px-4 py-2.5 text-destructive-foreground shadow-lg">
            <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-medium">{uploadError}</span>
            <button type="button" onClick={() => setUploadError(null)} className="ml-1 rounded p-0.5 hover:bg-white/20">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default React.memo(ChatInterface);
