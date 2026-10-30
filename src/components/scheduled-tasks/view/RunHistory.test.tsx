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
    scriptExitCode: null,
    scriptOutput: null,
    promptUsed: null,
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

  it('renders a skipped run with its reason, effective prompt and script output', async () => {
    listRuns.mockResolvedValueOnce({
      runs: [
        {
          ...makeRun('run-skip', 'session-skip'),
          status: 'skipped',
          output: 'nothing to do',
          promptUsed: 'Summarize the diff',
          scriptExitCode: 0,
          scriptOutput: '{"skip": true}',
        },
      ],
      total: 1,
    });

    render(<RunHistory taskId="task-1" refreshToken="1|x|y" />);

    await waitFor(() => expect(screen.getByText('status.skipped')).toBeTruthy());
    const body = document.body.textContent ?? '';
    expect(body).toContain('runs.skipReason');
    expect(body).toContain('nothing to do');
    expect(body).toContain('runs.effectivePrompt');
    expect(body).toContain('Summarize the diff');
    expect(body).toContain('runs.scriptOutput');
    expect(body).toContain('runs.exitCode: 0');
    expect(body).toContain('{"skip": true}');
    // A skipped run must not be presented as a generic output/error run.
    expect(body).not.toContain('runs.output');
    expect(body).not.toContain('runs.error');
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
