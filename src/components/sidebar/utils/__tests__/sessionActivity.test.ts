import { describe, expect, it } from 'vitest';
import type { SessionWithProvider } from '../../types/types';
import { compareSessionActivity, createSessionViewModel, getSessionTime } from '../utils';

const session = {
  id: 'session-1',
  lastActivity: '2025-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  __provider: 'copilot',
} as SessionWithProvider;

describe('processing session activity', () => {
  it('uses the processing start time instead of stale persisted activity', () => {
    const startTime = Date.parse('2025-02-01T12:00:00.000Z');

    expect(getSessionTime(session, startTime)).toBe('2025-02-01T12:00:00.000Z');
  });

  it('keeps persisted activity after processing stops', () => {
    expect(getSessionTime(session)).toBe(session.lastActivity);
  });

  it('sorts a running session above a newer inactive session', () => {
    const newerInactive = {
      ...session,
      id: 'session-2',
      lastActivity: '2025-03-01T00:00:00.000Z',
    };
    const startTimes = new Map([[session.id, Date.parse('2025-02-01T12:00:00.000Z')]]);

    expect(compareSessionActivity(session, newerInactive, startTimes)).toBeLessThan(0);
  });

  it('restores persisted ordering after processing stops', () => {
    const newerInactive = {
      ...session,
      id: 'session-2',
      lastActivity: '2025-03-01T00:00:00.000Z',
    };

    expect(compareSessionActivity(session, newerInactive)).toBeGreaterThan(0);
  });

  it('exposes processing activity to the sidebar view model', () => {
    const startTime = Date.parse('2025-02-01T12:00:00.000Z');
    const t = ((key: string) => key) as never;
    const viewModel = createSessionViewModel(
      session,
      new Date('2025-02-01T12:00:30.000Z'),
      t,
      true,
      startTime,
    );

    expect(viewModel.sessionTime).toBe('2025-02-01T12:00:00.000Z');
    expect(viewModel.isActive).toBe(true);
  });
});
