import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ScheduledTask, ScheduledTaskRun } from '../types';

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

import ScheduledTaskCard from './ScheduledTaskCard';

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

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    title: 'Nightly audit',
    prompt: 'Audit dependencies',
    projectPath: '/tmp/project',
    provider: 'claude',
    model: null,
    command: null,
    commandTimeoutSeconds: null,
    kind: 'daily',
    rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    nextRunAt: '2026-01-02T09:00:00.000Z',
    lastRunAt: '2026-01-01T09:00:00.000Z',
    lastStatus: 'success',
    lastError: null,
    enabled: true,
    runCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

const textWith = (needle: string) => (content: string) => content.includes(needle);

const noop = () => {};

function renderCard(task: ScheduledTask) {
  return render(
    <ScheduledTaskCard
      task={task}
      isBusy={false}
      isExpanded
      onToggleEnabled={noop}
      onRunNow={noop}
      onEdit={noop}
      onDelete={noop}
      onToggleHistory={noop}
    />,
  );
}

describe('ScheduledTaskCard run history freshness', () => {
  beforeEach(() => {
    listRuns.mockReset();
  });

  // Mirrors the reported repro: History open, a second run-now lands, the list
  // refresh advances the task record -> the open history must re-fetch.
  it('keeps the open run history in sync with the card after a new run', async () => {
    listRuns.mockResolvedValueOnce({ runs: [makeRun('run-1', 'session-1')], total: 1 });

    const { rerender } = renderCard(
      makeTask({ runCount: 1, lastRunAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:00:01.000Z' }),
    );

    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText(textWith('"total":1')).length).toBeGreaterThan(0));
    expect(screen.getAllByText(textWith('"count":1')).length).toBeGreaterThan(0);

    listRuns.mockResolvedValueOnce({
      runs: [makeRun('run-2', 'session-2'), makeRun('run-1', 'session-1')],
      total: 2,
    });

    rerender(
      <ScheduledTaskCard
        task={makeTask({ runCount: 2, lastRunAt: '2026-01-01T09:05:00.000Z', updatedAt: '2026-01-01T09:05:01.000Z' })}
        isBusy={false}
        isExpanded
        onToggleEnabled={noop}
        onRunNow={noop}
        onEdit={noop}
        onDelete={noop}
        onToggleHistory={noop}
      />,
    );

    // Card says 2 runs...
    await waitFor(() => expect(screen.getAllByText(textWith('"count":2')).length).toBeGreaterThan(0));
    // ...and the still-open history agrees: 2 of 2, no stale "1 of 1".
    await waitFor(() => expect(screen.getAllByText(textWith('"total":2')).length).toBeGreaterThan(0));
    expect(listRuns).toHaveBeenNthCalledWith(2, 'task-1', { limit: 20, offset: 0 });
    expect(screen.queryAllByText(textWith('"total":1')).length).toBe(0);
    expect(screen.getAllByText(textWith('session-2')).length).toBeGreaterThan(0);
  });

  it('marks tasks that have a script gate', async () => {
    listRuns.mockResolvedValue({ runs: [], total: 0 });

    const renderTask = (task: ScheduledTask) =>
      render(
        <ScheduledTaskCard
          task={task}
          isBusy={false}
          isExpanded={false}
          onToggleEnabled={noop}
          onRunNow={noop}
          onEdit={noop}
          onDelete={noop}
          onToggleHistory={noop}
        />,
      );

    const { rerender } = renderTask(makeTask({ command: 'echo hi', commandTimeoutSeconds: 30 }));
    expect(screen.getByLabelText('card.scriptGate')).toBeTruthy();

    rerender(
      <ScheduledTaskCard
        task={makeTask({ command: null, commandTimeoutSeconds: null })}
        isBusy={false}
        isExpanded={false}
        onToggleEnabled={noop}
        onRunNow={noop}
        onEdit={noop}
        onDelete={noop}
        onToggleHistory={noop}
      />,
    );
    expect(screen.queryByLabelText('card.scriptGate')).toBeNull();
  });
});
