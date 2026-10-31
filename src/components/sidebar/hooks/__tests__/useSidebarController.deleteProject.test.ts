import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import { useSidebarController } from '../useSidebarController';

vi.mock('../../../../utils/api', () => ({
  api: {
    deleteProject: vi.fn(),
  },
}));

const deleteProjectMock = vi.mocked(api.deleteProject);
const t = ((key: string) => key) as unknown as TFunction;

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'hidden-project',
    displayName: 'Hidden Project',
    fullPath: '/tmp/hidden-project',
    path: '/tmp/hidden-project',
    sessions: [],
    sessionMeta: { hasMore: false, total: 0 },
    ...overrides,
  };
}

function mockResponse(init: { ok: boolean; status: number; body?: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.body ?? {},
  } as unknown as Response;
}

function renderController(project: Project) {
  const onProjectDelete = vi.fn();
  // Keep the array identity stable across renders: a fresh literal would re-run the
  // hook's projects effect, reset state and loop forever.
  const projectList = [project];
  const hook = renderHook(() =>
    useSidebarController({
      projects: projectList,
      selectedProject: null,
      selectedSession: null,
      isLoading: false,
      isMobile: false,
      t,
      onRefresh: vi.fn(),
      onProjectSelect: vi.fn(),
      onSessionSelect: vi.fn(),
      onProjectDelete,
      setCurrentProject: vi.fn(),
      setSidebarVisible: vi.fn(),
      sidebarVisible: true,
    }),
  );
  return { hook, onProjectDelete };
}

describe('useSidebarController project delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the server-reported total for hidden-only projects', () => {
    const project = makeProject({ sessionMeta: { hasMore: false, total: 7 } });
    const { hook } = renderController(project);

    act(() => {
      hook.result.current.requestProjectDelete(project);
    });

    expect(hook.result.current.deleteConfirmation).toMatchObject({
      sessionCount: 7,
      hiddenSessionCount: 7,
    });
  });

  it('re-opens the confirmation in force mode on a 409, then force-deletes', async () => {
    const project = makeProject();
    deleteProjectMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 409,
        body: {
          error: 'Cannot delete project with existing sessions',
          code: 'PROJECT_HAS_SESSIONS',
          sessionCount: 7,
        },
      }),
    );

    const { hook, onProjectDelete } = renderController(project);

    act(() => {
      hook.result.current.requestProjectDelete(project);
    });
    expect(hook.result.current.deleteConfirmation).toMatchObject({
      sessionCount: 0,
      hiddenSessionCount: 0,
    });

    // First confirmation sends force=false and gets rejected by the server.
    await act(async () => {
      await hook.result.current.confirmDeleteProject();
    });

    expect(deleteProjectMock).toHaveBeenNthCalledWith(1, project.name, false);
    expect(hook.result.current.deleteConfirmation).toMatchObject({
      sessionCount: 7,
      hiddenSessionCount: 7,
      requiresForce: true,
    });
    expect(window.alert).not.toHaveBeenCalled();

    // The re-opened dialog is cancellable.
    act(() => {
      hook.result.current.setDeleteConfirmation(null);
    });
    expect(hook.result.current.deleteConfirmation).toBeNull();

    // Re-open in force mode and confirm: the retry goes out with force=true.
    act(() => {
      hook.result.current.setDeleteConfirmation({
        project,
        sessionCount: 7,
        hiddenSessionCount: 7,
        requiresForce: true,
      });
    });
    deleteProjectMock.mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));

    await act(async () => {
      await hook.result.current.confirmDeleteProject();
    });

    expect(deleteProjectMock).toHaveBeenNthCalledWith(2, project.name, true);
    expect(onProjectDelete).toHaveBeenCalledWith(project.name);
    expect(hook.result.current.deleteConfirmation).toBeNull();
  });

  it('does not loop when a forced retry is rejected again', async () => {
    const project = makeProject();
    const conflict = () =>
      mockResponse({
        ok: false,
        status: 409,
        body: {
          error: 'Cannot delete project with existing sessions',
          code: 'PROJECT_HAS_SESSIONS',
          sessionCount: 3,
        },
      });

    const { hook } = renderController(project);

    act(() => {
      hook.result.current.requestProjectDelete(project);
    });

    // First attempt: force=false, rejected.
    deleteProjectMock.mockResolvedValueOnce(conflict());
    await act(async () => {
      await hook.result.current.confirmDeleteProject();
    });
    expect(hook.result.current.deleteConfirmation).toMatchObject({ requiresForce: true });
    expect(window.alert).not.toHaveBeenCalled();

    // Forced retry rejected again: alert and close, never re-open.
    deleteProjectMock.mockResolvedValueOnce(conflict());
    await act(async () => {
      await hook.result.current.confirmDeleteProject();
    });
    expect(deleteProjectMock).toHaveBeenNthCalledWith(2, project.name, true);
    expect(window.alert).toHaveBeenCalledTimes(1);
    expect(hook.result.current.deleteConfirmation).toBeNull();

    // Nothing left to confirm: no further request is sent.
    await act(async () => {
      await hook.result.current.confirmDeleteProject();
    });
    expect(deleteProjectMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the generic alert for non-409 failures', async () => {
    const project = makeProject();
    deleteProjectMock.mockResolvedValueOnce(
      mockResponse({ ok: false, status: 500, body: { error: 'boom' } }),
    );

    const { hook } = renderController(project);

    act(() => {
      hook.result.current.requestProjectDelete(project);
    });
    await act(async () => {
      await hook.result.current.confirmDeleteProject();
    });

    expect(window.alert).toHaveBeenCalledWith('boom');
    expect(hook.result.current.deleteConfirmation).toBeNull();
  });
});
