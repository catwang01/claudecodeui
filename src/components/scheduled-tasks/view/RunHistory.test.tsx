import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ScheduledTaskRun } from '../types';

const { listRuns, listProjects } = vi.hoisted(() => ({ listRuns: vi.fn(), listProjects: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? key + JSON.stringify(options) : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../api', () => ({
  scheduledTasksApi: {
    listRuns: (id: string, options: { limit?: number; offset?: number }) => listRuns(id, options),
    listProjects: () => listProjects(),
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
    listProjects.mockReset();
    listProjects.mockResolvedValue([]);
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

  it('shows the run session as a readable title instead of only a bare id', async () => {
    listRuns.mockResolvedValueOnce({ runs: [makeRun('run-1', 'session-1')], total: 1 });
    listProjects.mockResolvedValueOnce([
      {
        name: '-tmp-alpha',
        displayName: 'Alpha',
        fullPath: '/tmp/alpha',
        sessions: [{ id: 'session-1', title: 'Fix the login bug' }],
      },
    ]);

    render(<RunHistory taskId="task-1" refreshToken="1|x|y" />);

    await waitFor(() => expect(screen.getByText('Fix the login bug')).toBeTruthy());
    // The project is exposed as the tooltip, and the raw id is still rendered.
    expect(screen.getByText('Fix the login bug').getAttribute('title')).toBe('Alpha');
    expect(screen.getAllByText(textWith('session-1')).length).toBeGreaterThan(0);
  });

  it('keeps the Open session action clickable when the session is unknown to the payload', async () => {
    // The lookup is display-only: an id the payload does not know must not turn
    // an otherwise working action into a dead button.
    listRuns.mockResolvedValueOnce({ runs: [makeRun('run-1', 'session-missing')], total: 1 });
    listProjects.mockResolvedValueOnce([]);
    const onOpenSession = vi.fn();

    render(<RunHistory taskId="task-1" refreshToken="1|x|y" onOpenSession={onOpenSession} />);

    const button = (await screen.findByText('runs.openSession')).closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onOpenSession).toHaveBeenCalledWith('session-missing');
  });

  it('keeps the Open session action clickable when the projects payload fails', async () => {
    listRuns.mockResolvedValueOnce({ runs: [makeRun('run-1', 'session-1')], total: 1 });
    listProjects.mockRejectedValueOnce(new Error('boom'));
    const onOpenSession = vi.fn();

    render(<RunHistory taskId="task-1" refreshToken="1|x|y" onOpenSession={onOpenSession} />);

    const button = (await screen.findByText('runs.openSession')).closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onOpenSession).toHaveBeenCalledWith('session-1');
  });

  it('still renders the runs when the projects payload fails', async () => {
    listRuns.mockResolvedValueOnce({ runs: [makeRun('run-1', 'session-1')], total: 1 });
    listProjects.mockRejectedValueOnce(new Error('boom'));

    render(<RunHistory taskId="task-1" refreshToken="1|x|y" />);

    await waitFor(() => expect(screen.getAllByText(textWith('session-1')).length).toBeGreaterThan(0));
    expect(screen.getByText('runs.title')).toBeTruthy();
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
