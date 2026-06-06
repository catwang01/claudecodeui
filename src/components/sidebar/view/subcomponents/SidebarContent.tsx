import { useMemo, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { Clock, Folder, MessageSquare, Search } from 'lucide-react';
import type { TFunction } from 'i18next';
import { ScrollArea } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { ConversationSearchResults, SearchProgress } from '../../hooks/useSidebarController';
import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarSessionItem from './SidebarSessionItem';
import { getProjectColor } from '../../utils/utils';
import { authenticatedFetch } from '../../../../utils/api';

type SearchMode = 'projects' | 'conversations' | 'recent';

function HighlightedSnippet({ snippet, highlights }: { snippet: string; highlights: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-800">
        {snippet.slice(h.start, h.end)}
      </mark>
    );
    cursor = h.end;
  }
  if (cursor < snippet.length) {
    parts.push(snippet.slice(cursor));
  }
  return (
    <span className="text-xs leading-relaxed text-muted-foreground">
      {parts}
    </span>
  );
}

type SidebarContentProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projects: Project[];
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
  conversationResults: ConversationSearchResults | null;
  isSearching: boolean;
  searchProgress: SearchProgress | null;
  onConversationResultClick: (projectName: string, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  updateAvailable: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  projectListProps: SidebarProjectListProps;
  scrollToProjectToken?: number;
  scrollToProjectName?: string | null;
  recentsTagLimit?: number;
  cleanMode?: boolean;
  t: TFunction;
};

export default function SidebarContent({
  isPWA,
  isMobile,
  isLoading,
  projects,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  conversationResults,
  isSearching,
  searchProgress,
  onConversationResultClick,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  updateAvailable,
  releaseInfo,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  projectListProps,
  scrollToProjectToken = 0,
  scrollToProjectName = null,
  recentsTagLimit = 10,
  cleanMode = false,
  t,
}: SidebarContentProps) {
  const showConversationSearch = (searchMode === 'conversations' || searchMode === 'recent') && searchFilter.trim().length >= 2;
  const hasPartialResults = conversationResults && conversationResults.results.length > 0;

  const RECENT_PAGE_SIZE = 10;
  const [visibleCount, setVisibleCount] = useState(RECENT_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [scrollTargetProject, setScrollTargetProject] = useState<string | null>(null);

  const [hiddenSet, setHiddenSet] = useState<Set<string>>(new Set());
  const [hideAutoDoc, setHideAutoDoc] = useState(true);

  useEffect(() => {
    authenticatedFetch('/api/settings/auto-doc')
      .then(res => res.json())
      .then(data => setHideAutoDoc(!!data.hideAutoDoc))
      .catch(() => {/* keep default false */});
  }, []);

  useEffect(() => {
    if (searchMode === 'projects' && scrollTargetProject) {
      requestAnimationFrame(() => {
        const el = scrollAreaRef.current?.querySelector<HTMLElement>(`[data-project-name="${CSS.escape(scrollTargetProject)}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setScrollTargetProject(null);
      });
    }
  }, [searchMode, scrollTargetProject]);

  useEffect(() => {
    if (!scrollToProjectName || scrollToProjectToken === 0) return;
    onSearchModeChange('projects');
    setScrollTargetProject(scrollToProjectName);
  }, [scrollToProjectToken, scrollToProjectName]);

  const hideSession = useCallback(async (sessionId: string, provider: string, lastActivity: string) => {
    const key = `${sessionId}:${provider}`;
    setHiddenSet(prev => new Set([...prev, key]));
    try {
      await authenticatedFetch(`/api/sessions/${sessionId}/hide`, {
        method: 'POST',
        body: JSON.stringify({ provider, lastActivity }),
      });
    } catch {
      setHiddenSet(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, []);

  const recentSessions = useMemo(() => {
    if (searchMode !== 'recent') return [];
    const all: Array<{ session: ReturnType<typeof projectListProps.getProjectSessions>[number]; project: Project }> = [];
    for (const project of projectListProps.filteredProjects) {
      for (const session of projectListProps.getProjectSessions(project)) {
        all.push({ session, project });
      }
    }
    return all
      .filter(({ session }) => {
        if (hideAutoDoc && session.isAutoDoc) return false;
        if (session.hiddenFromRecents) return false;
        const provider = session.__provider || 'claude';
        if (hiddenSet.has(`${session.id}:${provider}`)) return false;
        return true;
      })
      .sort((a, b) => {
        const getTime = (s: typeof a.session) => {
          const date = s.lastActivity || s.createdAt || '';
          return date ? new Date(date).getTime() : 0;
        };
        return getTime(b.session) - getTime(a.session);
      });
  }, [searchMode, projectListProps, hiddenSet, hideAutoDoc]);

  const filteredProjectListProps = useMemo(() => {
    if (!hideAutoDoc) return projectListProps;
    return {
      ...projectListProps,
      getProjectSessions: (project: Parameters<typeof projectListProps.getProjectSessions>[0]) =>
        projectListProps.getProjectSessions(project).filter(s => !s.isAutoDoc),
    };
  }, [projectListProps, hideAutoDoc]);

  const [selectedProjectFilter, setSelectedProjectFilter] = useState<string | null>(null);

  const projectBadges = useMemo(() => {
    const seen = new Map<string, { project: Project; count: number }>();
    for (const { project } of recentSessions.slice(0, recentsTagLimit)) {
      const existing = seen.get(project.name);
      if (existing) {
        existing.count++;
      } else {
        seen.set(project.name, { project, count: 1 });
      }
    }
    return Array.from(seen.values()).sort((a, b) => b.count - a.count);
  }, [recentSessions, recentsTagLimit]);

  useEffect(() => {
    if (selectedProjectFilter && !projectBadges.some(b => b.project.name === selectedProjectFilter)) {
      setSelectedProjectFilter(null);
    }
  }, [projectBadges, selectedProjectFilter]);

  useEffect(() => {
    setVisibleCount(RECENT_PAGE_SIZE);
  }, [searchMode, selectedProjectFilter]);

  const filteredRecentSessions = useMemo(() => {
    if (!selectedProjectFilter) return recentSessions;
    return recentSessions.filter(({ project }) => project.name === selectedProjectFilter);
  }, [recentSessions, selectedProjectFilter]);

  const loadMore = useCallback(() => {
    setVisibleCount(prev => prev + RECENT_PAGE_SIZE);
  }, []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, filteredRecentSessions.length, visibleCount]);

  return (
    <div
      className="flex h-full w-full flex-col bg-background/80 backdrop-blur-sm md:select-none"
      style={{}}
    >
      <SidebarHeader
        isPWA={isPWA}
        isMobile={isMobile}
        isLoading={isLoading}
        projectsCount={projects.length}
        searchFilter={searchFilter}
        onSearchFilterChange={onSearchFilterChange}
        onClearSearchFilter={onClearSearchFilter}
        searchMode={searchMode}
        onSearchModeChange={onSearchModeChange}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onCreateProject={onCreateProject}
        onCollapseSidebar={onCollapseSidebar}
        cleanMode={cleanMode}
        t={t}
      />

      <ScrollArea ref={scrollAreaRef} className="flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2">
        {searchMode === 'recent' && !showConversationSearch ? (
          <div className="space-y-1 px-2 py-1">
            {/* Project filter badges */}
            {projectBadges.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-2 pt-1">
                {projectBadges.map(({ project, count }) => {
                  const color = getProjectColor(project.name);
                  const isSelected = selectedProjectFilter === project.name;
                  return (
                    <button
                      key={project.name}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() =>
                        setSelectedProjectFilter(isSelected ? null : project.name)
                      }
                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all"
                      style={{
                        background: isSelected ? color.dot : color.bg,
                        border: `1px solid ${isSelected ? color.dot : color.border}`,
                        color: isSelected ? '#ffffff' : color.text,
                      }}
                    >
                      <span className="max-w-[80px] truncate">{project.displayName || project.name}</span>
                      <span style={{ opacity: isSelected ? 0.85 : 0.7 }}>{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {filteredRecentSessions.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <Clock className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {selectedProjectFilter ? 'No recent sessions for this project' : 'No recent sessions'}
                </p>
              </div>
            ) : filteredRecentSessions.slice(0, visibleCount).map(({ session, project }) => {
              const color = getProjectColor(project.name);
              return (
              <SidebarSessionItem
                key={`${project.name}-${session.id}`}
                variant="recents"
                project={project}
                session={session}
                currentTime={projectListProps.currentTime}
                isProcessing={projectListProps.processingSessions?.has(session.id) ?? false}
                isRead={session.isRead || (projectListProps.readSessionIds?.has(session.id) ?? false)}
                projectColorDot={color.dot}
                projectDisplayName={project.displayName || project.name}
                onSessionSelect={projectListProps.onSessionSelect}
                onHideSession={() => hideSession(session.id, session.__provider || 'claude', session.lastActivity || session.createdAt || '')}
                onDeleteSession={projectListProps.onDeleteSession}
                onRenameSession={projectListProps.onSaveEditingSession}
                onProjectNavigate={(proj) => {
                  setScrollTargetProject(proj.name);
                  onSearchModeChange('projects');
                  if (!projectListProps.expandedProjects.has(proj.name)) {
                    projectListProps.onToggleProject(proj.name);
                  }
                }}
                t={t}
              />
              );
            })}
            {visibleCount < filteredRecentSessions.length && (
              <div ref={sentinelRef} className="h-4" />
            )}
          </div>
        ) : showConversationSearch ? (
          isSearching && !hasPartialResults ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
              <p className="text-sm text-muted-foreground">{t('search.searching')}</p>
              {searchProgress && (
                <p className="mt-1 text-xs text-muted-foreground/60">
                  {t('search.projectsScanned', { count: searchProgress.scannedProjects })}/{searchProgress.totalProjects}
                </p>
              )}
            </div>
          ) : !isSearching && conversationResults && conversationResults.results.length === 0 ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('search.noResults')}</h3>
              <p className="text-sm text-muted-foreground">{t('search.tryDifferentQuery')}</p>
            </div>
          ) : hasPartialResults ? (
            <div className="space-y-3 px-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-muted-foreground">
                  {t('search.matches', { count: conversationResults.totalMatches })}
                </p>
                {isSearching && searchProgress && (
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-primary" />
                    <p className="text-[10px] text-muted-foreground/60">
                      {searchProgress.scannedProjects}/{searchProgress.totalProjects}
                    </p>
                  </div>
                )}
              </div>
              {isSearching && searchProgress && (
                <div className="mx-1 h-0.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-all duration-300"
                    style={{ width: `${Math.round((searchProgress.scannedProjects / searchProgress.totalProjects) * 100)}%` }}
                  />
                </div>
              )}
              {conversationResults.results.map((projectResult) => (
                <div key={projectResult.projectName} className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1 py-1">
                    <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-medium text-foreground">
                      {projectResult.projectDisplayName}
                    </span>
                  </div>
                  {projectResult.sessions.map((session) => (
                    <button
                      key={`${projectResult.projectName}-${session.sessionId}`}
                      className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50"
                      onClick={() => onConversationResultClick(
                        projectResult.projectName,
                        session.sessionId,
                        session.provider || session.matches[0]?.provider || 'claude',
                        session.matches[0]?.timestamp,
                        session.matches[0]?.snippet
                      )}
                    >
                      <div className="mb-1 flex items-center gap-1.5">
                        <MessageSquare className="h-3 w-3 flex-shrink-0 text-primary" />
                        <span className="truncate text-xs font-medium text-foreground">
                          {session.sessionSummary}
                        </span>
                        {session.provider && session.provider !== 'claude' && (
                          <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                            {session.provider}
                          </span>
                        )}
                      </div>
                      <div className="space-y-1 pl-4">
                        {session.matches.map((match, idx) => (
                          <div key={idx} className="flex items-start gap-1">
                            <span className="mt-0.5 flex-shrink-0 text-[10px] font-medium uppercase text-muted-foreground/60">
                              {match.role === 'user' ? 'U' : 'A'}
                            </span>
                            <HighlightedSnippet
                              snippet={match.snippet}
                              highlights={match.highlights}
                            />
                          </div>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null
        ) : (
          <SidebarProjectList {...filteredProjectListProps} />
        )}
      </ScrollArea>

      <SidebarFooter
        updateAvailable={updateAvailable}
        releaseInfo={releaseInfo}
        latestVersion={latestVersion}
        currentVersion={currentVersion}
        onShowVersionModal={onShowVersionModal}
        onShowSettings={onShowSettings}
        cleanMode={cleanMode}
        t={t}
      />
    </div>
  );
}
