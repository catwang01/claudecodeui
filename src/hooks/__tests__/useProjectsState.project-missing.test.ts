import { describe, expect, it } from 'vitest';
import type { Project, ProjectAvailability } from '../../types/app';
import { mergeProjects, projectHasChanges, projectsHaveChanges } from '../useProjectsState';

const available: ProjectAvailability = {
  status: 'available',
  available: true,
  readable: true,
  reason: null,
  errorCode: null,
};

const missing: ProjectAvailability = {
  status: 'missing',
  available: false,
  readable: false,
  reason: 'not_found',
  errorCode: 'ENOENT',
};

const base: Project = {
  name: 'project',
  displayName: 'Project',
  fullPath: '/tmp/project',
  availability: available,
  sessions: [],
};

describe('availability-aware project merging (issue #16)', () => {
  it('detects an available -> missing transition', () => {
    const next: Project = { ...base, availability: missing };
    expect(projectHasChanges(base, next, true)).toBe(true);
    expect(projectsHaveChanges([base], [next], true)).toBe(true);
  });

  it('rebuilds the project object so the UI can refresh the badge', () => {
    const next: Project = { ...base, availability: missing };
    const merged = mergeProjects([base], [next]);
    expect(merged[0].availability?.status).toBe('missing');
  });

  it('keeps the previous reference when only equal availability payloads are re-sent', () => {
    const next: Project = {
      ...base,
      availability: { ...available },
      sessions: [],
    };
    expect(projectHasChanges(base, next, true)).toBe(false);
    expect(mergeProjects([base], [next])[0]).toBe(base);
  });

  it('detects a readable -> unreadable change even when status/reason are unchanged', () => {
    const next: Project = {
      ...base,
      availability: { ...available, readable: false },
    };
    expect(projectHasChanges(base, next, true)).toBe(true);
  });

  it('detects an available flag change even when status/reason are unchanged', () => {
    const next: Project = {
      ...base,
      availability: { ...available, available: false },
    };
    expect(projectHasChanges(base, next, true)).toBe(true);
  });

  it('drops a project that disappears from the server payload', () => {
    expect(mergeProjects([base], []).length).toBe(0);
  });
});
