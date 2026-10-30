import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ScheduledTaskRun } from '../types';

const { listRuns } = vi.hoisted(() => ({ listRuns: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? key + JSON.stringify(options) : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../api', () => ({
  scheduledTasksApi: {
    listRuns: (id: string, options: { limit?: number; offset?: number }) => listRuns(id, options),
  },
}));

import RunHistory from './RunHistory';

function makeRun(id: string, sessionId: string): ScheduledTaskRun {
  return {
    id,
    taskId: 'task-1',
    status: 'success',
    trigger: 'manual',
    scheduledFor: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    sessionId,
    output: null,
    error: null,
  };
}

const textWith = (needle: string) => (content: string) => content.includes(needle);

describe('RunHistory', () => {
  beforeEach(() => {
    listRuns.mockReset();
  });

  it('re-fetches an already mounted history when the task record advances', async () => {
    listRuns.mockResolvedValueOnce({ runs: [makeRun('run-1', 'session-1')], total: 1 });

    const { rerender } = render(
      <RunHistory taskId="task-1" refreshToken="1|2026-01-01T00:00:01.000Z|2026-01-01T00:00:02.000Z" />,
    );

    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText(textWith('session-1')).length).toBeGreaterThan(0));
    expect(screen.getAllByText(textWith('"total":1')).length).toBeGreaterThan(0);

    // A second run is recorded while the history section stays open.
    listRuns.mockResolvedValueOnce({
      runs: [makeRun('run-2', 'session-2'), makeRun('run-1', 'session-1')],
      total: 2,
    });

    rerender(<RunHistory taskId="task-1" refreshToken="2|2026-01-01T00:01:00.000Z|2026-01-01T00:01:01.000Z" />);

    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
    expect(listRuns).toHaveBeenNthCalledWith(2, 'task-1', { limit: 20, offset: 0 });

    // Card and history now agree: the new run and the new total are rendered.
    await waitFor(() => expect(screen.getAllByText(textWith('session-2')).length).toBeGreaterThan(0));
    expect(screen.getAllByText(textWith('"total":2')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(textWith('"total":1')).length).toBe(0);
  });

  it('does not re-fetch while the refresh token is unchanged', async () => {
    listRuns.mockResolvedValue({ runs: [], total: 0 });

    const { rerender } = render(<RunHistory taskId="task-1" refreshToken="1|x|y" />);
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));

    rerender(<RunHistory taskId="task-1" refreshToken="1|x|y" />);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listRuns).toHaveBeenCalledTimes(1);
  });
});
