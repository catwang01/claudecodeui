import { describe, it, expect } from 'vitest';
import type { Project } from '../../../types/app';
import { findSessionInProjects } from './sessionLookup';

// Hardcoded on purpose: deriving this list from the production constant would
// make the test agree with any future typo or removal in that constant.
const PROVIDER_COLLECTIONS = [
  'sessions',
  'cursorSessions',
  'codexSessions',
  'geminiSessions',
  'copilotSessions',
] as const;

function makeProject(overrides: Partial<Project> & { name: string }): Project {
  return {
    displayName: overrides.name,
    fullPath: '/tmp/' + overrides.name,
    ...overrides,
  } as Project;
}

function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, ...extra };
}

describe('findSessionInProjects', () => {
  it('resolves a session from the default claude collection', () => {
    const projects = [
      makeProject({ name: 'alpha', displayName: 'Alpha', sessions: [session('s1', { title: 'Fix the thing' })] }),
    ];

    expect(findSessionInProjects(projects, 's1')).toEqual({
      projectName: 'Alpha',
      title: 'Fix the thing',
    });
  });

  it.each(PROVIDER_COLLECTIONS)('resolves a session found in %s', (collection) => {
    const projects = [
      makeProject({ name: 'alpha', [collection]: [session('s1', { title: 'from ' + collection })] } as never),
    ];

    expect(findSessionInProjects(projects, 's1')).toMatchObject({ title: 'from ' + collection });
  });

  it('returns null for an unknown id, an empty id, or an empty payload', () => {
    const projects = [makeProject({ name: 'alpha', sessions: [session('s1')] })];

    expect(findSessionInProjects(projects, 'nope')).toBeNull();
    expect(findSessionInProjects(projects, '')).toBeNull();
    expect(findSessionInProjects([], 's1')).toBeNull();
  });

  it('falls back title -> summary -> name -> session id', () => {
    const projects = [
      makeProject({
        name: 'alpha',
        sessions: [
          session('with-title', { title: 'T', summary: 'S', name: 'N' }),
          session('with-summary', { summary: 'S', name: 'N' }),
          session('with-name', { name: 'N' }),
          session('bare'),
        ],
      }),
    ];

    expect(findSessionInProjects(projects, 'with-title')?.title).toBe('T');
    expect(findSessionInProjects(projects, 'with-summary')?.title).toBe('S');
    expect(findSessionInProjects(projects, 'with-name')?.title).toBe('N');
    expect(findSessionInProjects(projects, 'bare')?.title).toBe('bare');
  });

  it('ignores empty-string titles instead of rendering a blank row', () => {
    const projects = [
      makeProject({ name: 'alpha', sessions: [session('s1', { title: '', summary: '', name: 'N' })] }),
    ];

    expect(findSessionInProjects(projects, 's1')?.title).toBe('N');
  });

  it('prefers displayName but falls back to the claude dir name', () => {
    const named = [makeProject({ name: '-tmp-alpha', displayName: 'Alpha', sessions: [session('s1')] })];
    const unnamed = [makeProject({ name: '-tmp-alpha', displayName: '', sessions: [session('s1')] })];

    expect(findSessionInProjects(named, 's1')?.projectName).toBe('Alpha');
    expect(findSessionInProjects(unnamed, 's1')?.projectName).toBe('-tmp-alpha');
  });

  it('does not blow up on malformed payloads', () => {
    const projects = [
      makeProject({ name: 'a', sessions: undefined }),
      makeProject({ name: 'b', sessions: [null as never, session('s1', { title: 'ok' })] }),
    ];

    expect(findSessionInProjects(projects, 's1')?.title).toBe('ok');
  });

  it('returns the first match when two projects expose the same id', () => {
    const projects = [
      makeProject({ name: 'a', displayName: 'A', sessions: [session('s1', { title: 'first' })] }),
      makeProject({ name: 'b', displayName: 'B', sessions: [session('s1', { title: 'second' })] }),
    ];

    expect(findSessionInProjects(projects, 's1')).toMatchObject({ projectName: 'A', title: 'first' });
  });
});
