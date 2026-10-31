import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import {
  bumpProjectFileListRevision,
  resetProjectFileListRevisions,
} from '../../../../utils/projectFileListRevision';
import { useFileMentions } from '../useFileMentions';

vi.mock('../../../../utils/api', () => ({ api: { getFiles: vi.fn() } }));

const project = {
  name: 'proj-a',
  displayName: 'proj-a',
  fullPath: '/tmp/proj-a',
} as unknown as Project;

// Must be a stable reference: a fresh [] on every render re-runs the hook effect.
const noProjects: Project[] = [];

const fetchResult = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

const treeContaining = (fileName: string) => [
  {
    name: 'victim-folder',
    type: 'directory',
    path: '/tmp/proj-a/victim-folder',
    children: [{ name: fileName, type: 'file', path: `/tmp/proj-a/victim-folder/${fileName}` }],
  },
];

const suggestsDeletedFolder = (files: { path: string }[]) =>
  files.some((file) => file.path.startsWith('victim-folder/'));

const renderMentions = () =>
  renderHook(() => {
    const [input, setInput] = useState('@victim');
    return useFileMentions({
      selectedProject: project,
      allProjects: noProjects,
      input,
      setInput,
      textareaRef: { current: null },
    });
  });

describe('useFileMentions — a deleted folder must stop being recognized', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectFileListRevisions();
  });

  it('refetches and drops the folder once the file tree reports the mutation', async () => {
    const getFiles = api.getFiles as unknown as ReturnType<typeof vi.fn>;
    getFiles.mockResolvedValueOnce(fetchResult(treeContaining('marker.txt')));
    getFiles.mockResolvedValueOnce(fetchResult([]));

    const { result } = renderMentions();

    // The user types "@victim" and the listing is fetched for the first time.
    act(() => result.current.setCursorPosition('@victim'.length));

    await waitFor(() => expect(getFiles).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(suggestsDeletedFolder(result.current.filteredFiles)).toBe(true),
    );

    // ...then deletes victim-folder through the Files tree's Delete Folder action.
    act(() => bumpProjectFileListRevision(project.name));

    await waitFor(() => expect(getFiles).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(suggestsDeletedFolder(result.current.filteredFiles)).toBe(false),
    );
  });

  it('keeps the suggestion while nothing was deleted (control)', async () => {
    const getFiles = api.getFiles as unknown as ReturnType<typeof vi.fn>;
    getFiles.mockResolvedValue(fetchResult(treeContaining('marker.txt')));

    const { result } = renderMentions();

    act(() => result.current.setCursorPosition('@victim'.length));

    await waitFor(() =>
      expect(suggestsDeletedFolder(result.current.filteredFiles)).toBe(true),
    );
    expect(getFiles).toHaveBeenCalledTimes(1);
  });

  it('ignores mutations of a different project', async () => {
    const getFiles = api.getFiles as unknown as ReturnType<typeof vi.fn>;
    getFiles.mockResolvedValue(fetchResult(treeContaining('marker.txt')));

    const { result } = renderMentions();

    act(() => result.current.setCursorPosition('@victim'.length));
    await waitFor(() =>
      expect(suggestsDeletedFolder(result.current.filteredFiles)).toBe(true),
    );

    act(() => bumpProjectFileListRevision('some-other-project'));

    expect(getFiles).toHaveBeenCalledTimes(1);
    expect(suggestsDeletedFolder(result.current.filteredFiles)).toBe(true);
  });
});
