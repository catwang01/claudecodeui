import { describe, expect, it } from 'vitest';
import { resolveDeleteFailure, resolveDeleteRequest } from '../deleteProject';

const projectWithTotal = (total: number | null | undefined) => ({
  sessionMeta: total === undefined ? undefined : { total },
});

describe('resolveDeleteRequest', () => {
  it('uses the server total when every session is hidden from the sidebar', () => {
    expect(resolveDeleteRequest(projectWithTotal(7), 0)).toEqual({
      sessionCount: 7,
      hiddenSessionCount: 7,
      force: true,
    });
  });

  it('falls back to the visible count when the payload has no server total', () => {
    expect(resolveDeleteRequest(projectWithTotal(undefined), 3)).toEqual({
      sessionCount: 3,
      hiddenSessionCount: 0,
      force: true,
    });
  });

  it('treats a non-finite server total as zero', () => {
    expect(resolveDeleteRequest({ sessionMeta: { total: Number.NaN } }, 0)).toEqual({
      sessionCount: 0,
      hiddenSessionCount: 0,
      force: false,
    });
  });

  it('does not force for an empty project', () => {
    expect(resolveDeleteRequest(projectWithTotal(0), 0)).toEqual({
      sessionCount: 0,
      hiddenSessionCount: 0,
      force: false,
    });
  });

  it('prefers the larger of the visible and server totals', () => {
    expect(resolveDeleteRequest(projectWithTotal(2), 5)).toEqual({
      sessionCount: 5,
      hiddenSessionCount: 0,
      force: true,
    });
  });

  it('handles a missing project/sessionMeta without throwing', () => {
    expect(resolveDeleteRequest({}, 2)).toEqual({
      sessionCount: 2,
      hiddenSessionCount: 0,
      force: true,
    });
  });
});

describe('resolveDeleteFailure', () => {
  it('flags a 409 with the server count as needing force confirmation', () => {
    expect(
      resolveDeleteFailure({
        status: 409,
        body: { code: 'PROJECT_HAS_SESSIONS', sessionCount: 7 },
        fallbackCount: 0,
        visibleCount: 0,
      }),
    ).toEqual({ needsForceConfirmation: true, sessionCount: 7, hiddenSessionCount: 7 });
  });

  it('flags the PROJECT_HAS_SESSIONS code even on a non-409 status', () => {
    expect(
      resolveDeleteFailure({
        status: 500,
        body: { code: 'PROJECT_HAS_SESSIONS', sessionCount: 2 },
        fallbackCount: 0,
        visibleCount: 0,
      }).needsForceConfirmation,
    ).toBe(true);
  });

  it('keeps the fallback count when the 409 body carries no sessionCount', () => {
    expect(
      resolveDeleteFailure({ status: 409, body: null, fallbackCount: 3, visibleCount: 1 }),
    ).toEqual({ needsForceConfirmation: true, sessionCount: 3, hiddenSessionCount: 2 });
  });

  it('does not force for a generic 500', () => {
    expect(
      resolveDeleteFailure({
        status: 500,
        body: { error: 'boom' },
        fallbackCount: 0,
        visibleCount: 0,
      }),
    ).toEqual({ needsForceConfirmation: false, sessionCount: 1, hiddenSessionCount: 1 });
  });

  it('never resolves to zero sessions when the server says the project is non-empty', () => {
    expect(
      resolveDeleteFailure({ status: 409, body: undefined, fallbackCount: 0, visibleCount: 0 }),
    ).toEqual({ needsForceConfirmation: true, sessionCount: 1, hiddenSessionCount: 1 });
  });
});
