import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../../types/app';
import { filterProjects } from '../utils';

const project = (
  name: string,
  options: { path?: string; fullPath?: string; displayName?: string } = {},
): Project => ({
  name,
  displayName: options.displayName ?? name,
  fullPath: options.fullPath ?? options.path ?? '',
  path: options.path,
});

const names = (projects: Project[]): string[] => projects.map((entry) => entry.name);

describe('filterProjects exclude patterns', () => {
  it('excludes a directory whose basename matches an anchored pattern', () => {
    const projects = [
      project('agent-xx', { path: '/Users/x/MyFolder/agent-xx' }),
      project('normal', { path: '/Users/x/MyFolder/normal' }),
    ];

    expect(names(filterProjects(projects, '', ['^agent.*']))).toEqual(['normal']);
  });

  it('excludes a directory with a trailing separator on its path', () => {
    const projects = [
      project('agent-xx', { path: '/Users/x/MyFolder/agent-xx/' }),
      project('normal', { path: '/Users/x/MyFolder/normal/' }),
    ];

    expect(names(filterProjects(projects, '', ['^agent.*']))).toEqual(['normal']);
  });

  it('excludes case-insensitively', () => {
    const projects = [project('agent-xx', { path: '/Users/x/MyFolder/agent-xx' })];

    expect(names(filterProjects(projects, '', ['^AGENT']))).toEqual([]);
  });

  it('still excludes via plain substring matches on the full path', () => {
    const projects = [
      project('agent-xx', { path: '/Users/x/MyFolder/agent-xx' }),
      project('normal', { path: '/Users/x/MyFolder/normal' }),
    ];

    expect(names(filterProjects(projects, '', ['agent-xx']))).toEqual(['normal']);
  });

  it('still excludes patterns anchored at the end of the full path', () => {
    const projects = [
      project('legacy-archive', { path: '/Users/x/MyFolder/legacy-archive' }),
      project('legacy', { path: '/Users/x/MyFolder/legacy' }),
    ];

    expect(names(filterProjects(projects, '', ['.*-archive$']))).toEqual(['legacy']);
  });

  it('matches the directory name in Windows paths', () => {
    const projects = [
      project('agent-01', { path: String.raw`C:\work\agent-01` }),
      project('normal', { path: String.raw`C:\work\normal` }),
    ];

    expect(names(filterProjects(projects, '', ['^agent.*']))).toEqual(['normal']);
  });

  it('ignores invalid regex patterns without throwing', () => {
    const projects = [project('normal', { path: '/Users/x/MyFolder/normal' })];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => filterProjects(projects, '', ['['])).not.toThrow();
      expect(names(filterProjects(projects, '', ['[']))).toEqual(['normal']);
      expect(names(filterProjects(projects, '', ['', '   ']))).toEqual(['normal']);
    } finally {
      warn.mockRestore();
    }
  });

  it('applies the search filter alongside exclude patterns', () => {
    const projects = [
      project('agent-xx', { path: '/Users/x/MyFolder/agent-xx' }),
      project('normal-one', { path: '/Users/x/MyFolder/normal-one' }),
      project('normal-two', { path: '/Users/x/MyFolder/normal-two' }),
    ];

    expect(names(filterProjects(projects, 'normal-one', ['^agent.*']))).toEqual(['normal-one']);
  });

  it('falls back to fullPath when path is undefined', () => {
    const projects = [
      project('agent-xx', { fullPath: '/Users/x/MyFolder/agent-xx' }),
      project('normal', { fullPath: '/Users/x/MyFolder/normal' }),
    ];

    expect(names(filterProjects(projects, '', ['^agent.*']))).toEqual(['normal']);
  });

  it('does not exclude a project when only its display name matches', () => {
    const projects = [
      project('unrelated-directory', {
        path: '/Users/x/MyFolder/unrelated-directory',
        displayName: 'agent-xx',
      }),
    ];

    expect(names(filterProjects(projects, '', ['^agent.*']))).toEqual(['unrelated-directory']);
  });
});
