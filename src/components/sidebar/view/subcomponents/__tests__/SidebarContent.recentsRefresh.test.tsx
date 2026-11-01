import { render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { beforeEach, expect, test, vi } from 'vitest';
import type { Project, ProjectSession } from '../../../../../types/app';
import type { SidebarProjectListProps } from '../SidebarProjectList';
import SidebarContent from '../SidebarContent';

const { recentSessionsMock, authenticatedFetchMock } = vi.hoisted(() => ({
  recentSessionsMock: vi.fn(),
  authenticatedFetchMock: vi.fn(),
}));

vi.mock('../../../../../utils/api', () => ({
  api: { recentSessions: recentSessionsMock },
  authenticatedFetch: authenticatedFetchMock,
}));
vi.mock('../SidebarHeader', () => ({ default: () => null }));
vi.mock('../SidebarFooter', () => ({ default: () => null }));
vi.mock('../SidebarProjectList', () => ({ default: () => null }));
vi.mock('../SidebarSessionItem', () => ({ default: () => null }));

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const t = ((key: string) => key) as unknown as TFunction;

const project = (sessions: ProjectSession[]): Project => ({
  name: 'demo-project',
  displayName: 'Demo Project',
  path: '/tmp/demo-project',
  fullPath: '/tmp/demo-project',
  sessions,
});

const session = (id: string): ProjectSession => ({
  id,
  summary: id,
  lastActivity: '2026-01-01T00:00:00.000Z',
  projectPath: '/tmp/demo-project',
  __provider: 'claude',
});

const getProjectSessions = (p: Project): ProjectSession[] => p.sessions ?? [];

function makeProps(projects: Project[]): Record<string, unknown> {
  const projectListProps = {
    projects,
    filteredProjects: projects,
    selectedProject: null,
    selectedSession: null,
    isLoading: false,
    loadingProgress: null,
    expandedProjects: new Set<string>(),
    editingProject: null,
    editingName: '',
    loadingSessions: {},
    initialSessionsLoaded: new Set<string>(),
    currentTime: new Date('2026-01-01T00:00:00.000Z'),
    editingSession: null,
    editingSessionName: '',
    deletingProjects: new Set<string>(),
    archivingProjects: new Set<string>(),
    tasksEnabled: true,
    mcpServerStatus: {},
    getProjectSessions,
    isProjectStarred: () => false,
    onEditingNameChange: vi.fn(),
    onToggleProject: vi.fn(),
    onProjectSelect: vi.fn(),
    onToggleStarProject: vi.fn(),
    onStartEditingProject: vi.fn(),
    onCancelEditingProject: vi.fn(),
    onSaveProjectName: vi.fn(),
    onDeleteProject: vi.fn(),
    onArchiveProject: vi.fn(),
    onSessionSelect: vi.fn(),
    onDeleteSession: vi.fn(),
    onForkSession: vi.fn(),
    onLoadMoreSessions: vi.fn(),
    onNewSession: vi.fn(),
    onEditingSessionNameChange: vi.fn(),
    onStartEditingSession: vi.fn(),
    onCancelEditingSession: vi.fn(),
    onSaveEditingSession: vi.fn(),
    t,
  } as unknown as SidebarProjectListProps;

  return {
    isPWA: false,
    isMobile: false,
    isLoading: false,
    projects,
    searchFilter: '',
    onSearchFilterChange: vi.fn(),
    onClearSearchFilter: vi.fn(),
    searchMode: 'recent',
    onSearchModeChange: vi.fn(),
    conversationResults: null,
    isSearching: false,
    searchProgress: null,
    onConversationResultClick: vi.fn(),
    onRefresh: vi.fn(),
    isRefreshing: false,
    onCreateProject: vi.fn(),
    onCollapseSidebar: vi.fn(),
    updateAvailable: false,
    releaseInfo: null,
    latestVersion: null,
    currentVersion: '1.0.0',
    onShowVersionModal: vi.fn(),
    onShowSettings: vi.fn(),
    projectListProps,
    t,
  };
}

// Spread targets must be concrete props, not `never` (TS2698).
const toProps = (p: Project[]) => makeProps(p) as unknown as ComponentProps<typeof SidebarContent>;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
  recentSessionsMock.mockReset();
  authenticatedFetchMock.mockReset();
  authenticatedFetchMock.mockResolvedValue({ json: async () => ({}) });
  recentSessionsMock.mockResolvedValue({
    ok: true,
    json: async () => ({ sessions: [session('existing')], hasMore: false, offset: 0, limit: 50 }),
  });
});

test('refetches recents when a new session (e.g. a fork) appears in the projects list', async () => {
  const first = project([session('existing')]);
  const view = render(<SidebarContent {...toProps([first])} />);

  await waitFor(() => expect(recentSessionsMock).toHaveBeenCalledTimes(1));

  // A fork was indexed: the projects list now carries a session the recents fetch never saw.
  const forked = session('fresh-fork');
  const second = project([session('existing'), forked]);
  view.rerender(<SidebarContent {...toProps([second])} />);

  await waitFor(() => expect(recentSessionsMock).toHaveBeenCalledTimes(2));
  expect(recentSessionsMock).toHaveBeenLastCalledWith(50, 0);
});

test('does not refetch when only mutable fields change', async () => {
  const first = project([session('existing')]);
  const view = render(<SidebarContent {...toProps([first])} />);

  await waitFor(() => expect(recentSessionsMock).toHaveBeenCalledTimes(1));

  const sameIdNewActivity = { ...session('existing'), lastActivity: '2026-02-02T00:00:00.000Z', messageCount: 42 };
  const second = project([sameIdNewActivity]);
  view.rerender(<SidebarContent {...toProps([second])} />);

  // Give the 300 ms debounce room to fire; it must not.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(recentSessionsMock).toHaveBeenCalledTimes(1);
});
