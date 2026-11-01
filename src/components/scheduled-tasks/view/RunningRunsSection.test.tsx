import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { RunningScheduledTaskRun } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? key + JSON.stringify(options) : key),
    i18n: { language: 'en' },
  }),
}));

import RunningRunsSection from './RunningRunsSection';

function makeRun(overrides: Partial<RunningScheduledTaskRun> = {}): RunningScheduledTaskRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    taskTitle: 'Nightly audit',
    projectPath: '/tmp/project',
    projectPaths: ['/tmp/project'],
    status: 'running',
    trigger: 'schedule',
    scheduledFor: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    agentStartedAt: '2026-01-01T00:00:00.500Z',
    sessionId: 'session-1',
    error: null,
    ...overrides,
  };
}

describe('RunningRunsSection', () => {
  it('shows the empty state when nothing is running', () => {
    render(<RunningRunsSection runs={[]} />);

    expect(screen.getByText('runningRuns.emptyTitle')).toBeTruthy();
  });

  it('lists a running run with its task, project and open-session action', () => {
    const onOpenSession = vi.fn();
    render(<RunningRunsSection runs={[makeRun()]} onOpenSession={onOpenSession} />);

    expect(screen.getByText('Nightly audit')).toBeTruthy();
    expect(screen.getByText(/runningRuns\.project/)).toBeTruthy();
    expect(screen.getByText('runs.inProgress')).toBeTruthy();

    fireEvent.click(screen.getByText('runs.openSession'));
    expect(onOpenSession).toHaveBeenCalledWith('session-1');
  });

  it('labels a run still in the script gate', () => {
    render(<RunningRunsSection runs={[makeRun({ agentStartedAt: null })]} />);

    expect(screen.getByText('runs.gatePhase')).toBeTruthy();
  });
});
