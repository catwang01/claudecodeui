import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bumpProjectFileListRevision,
  getProjectFileListRevision,
  resetProjectFileListRevisions,
  subscribeProjectFileListRevision,
} from '../projectFileListRevision';

describe('projectFileListRevision', () => {
  beforeEach(() => {
    resetProjectFileListRevisions();
  });

  it('starts at revision 0 for unknown projects', () => {
    expect(getProjectFileListRevision('proj-a')).toBe(0);
  });

  it('bumps per project and ignores empty project names', () => {
    bumpProjectFileListRevision('proj-a');
    bumpProjectFileListRevision('proj-a');
    bumpProjectFileListRevision('proj-b');
    bumpProjectFileListRevision(undefined);
    bumpProjectFileListRevision(null);
    bumpProjectFileListRevision('');

    expect(getProjectFileListRevision('proj-a')).toBe(2);
    expect(getProjectFileListRevision('proj-b')).toBe(1);
  });

  it('notifies subscribers with the changed project only', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectFileListRevision(listener);

    bumpProjectFileListRevision('proj-a');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('proj-a');

    unsubscribe();
    bumpProjectFileListRevision('proj-a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives a listener unsubscribing during notification', () => {
    const second = vi.fn();
    const unsubscribeFirst = subscribeProjectFileListRevision(() => unsubscribeFirst());
    const unsubscribeSecond = subscribeProjectFileListRevision(second);

    expect(() => bumpProjectFileListRevision('proj-a')).not.toThrow();
    expect(second).toHaveBeenCalledWith('proj-a');

    unsubscribeSecond();
  });
});
