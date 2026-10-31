import { describe, expect, it } from 'vitest';
import type { Project, ProjectAvailability } from '../../../../types/app';
import {
  getProjectUnavailableReasonKey,
  isProjectAvailabilityDegraded,
  isProjectUnavailable,
} from '../utils';

const project = (availability?: ProjectAvailability): Project => ({
  name: 'project',
  displayName: 'Project',
  fullPath: '/tmp/project',
  availability,
});

const available: ProjectAvailability = {
  status: 'available',
  available: true,
  readable: true,
  reason: null,
  errorCode: null,
};

describe('project availability helpers (issue #16)', () => {
  it('marks a missing directory as unavailable', () => {
    const missing: ProjectAvailability = {
      status: 'missing',
      available: false,
      readable: false,
      reason: 'not_found',
      errorCode: 'ENOENT',
    };
    expect(isProjectUnavailable(project(missing))).toBe(true);
  });

  it('keeps permission failures available so the project is never hidden', () => {
    const locked: ProjectAvailability = {
      status: 'available',
      available: true,
      readable: false,
      reason: 'permission_denied',
      errorCode: 'EACCES',
    };
    const entry = project(locked);
    expect(isProjectUnavailable(entry)).toBe(false);
    expect(isProjectAvailabilityDegraded(entry)).toBe(true);
  });

  it('treats a project without an availability payload as available', () => {
    expect(isProjectUnavailable(project(undefined))).toBe(false);
    expect(isProjectUnavailable(null)).toBe(false);
    expect(isProjectAvailabilityDegraded(project(undefined))).toBe(false);
  });

  it('does not flag a readable project as degraded', () => {
    expect(isProjectAvailabilityDegraded(project(available))).toBe(false);
  });

  it('maps missing reasons to i18n keys', () => {
    expect(getProjectUnavailableReasonKey(project({
      status: 'missing',
      available: false,
      readable: false,
      reason: 'not_a_directory',
      errorCode: 'ENOTDIR',
    }))).toBe('projects.directoryNotADirectory');
    expect(getProjectUnavailableReasonKey(project({
      status: 'missing',
      available: false,
      readable: false,
      reason: 'not_found',
      errorCode: 'ENOENT',
    }))).toBe('projects.directoryMissing');
  });
});
