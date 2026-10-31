import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ScheduledTask } from '../types';

const hook = vi.hoisted(() => ({
  tasks: [] as ScheduledTask[],
  runNow: vi.fn(),
  refresh: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? key + JSON.stringify(options) : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

vi.mock('../hooks/useScheduledTasks', () => ({
  useScheduledTasks: () => ({
    tasks: hook.tasks,
    isLoading: false,
    error: null,
    refresh: hook.refresh,
    createTask: hook.createTask,
    updateTask: hook.updateTask,
    deleteTask: hook.deleteTask,
    runNow: hook.runNow,
  }),
}));

vi.mock('../api', () => ({ scheduledTasksApi: {} }));

import ScheduledTasksPanel from './ScheduledTasksPanel';

// Rendering these trees is cheap, but CI/dev boxes can be heavily loaded, so
// keep a generous per-test budget instead of relying on the 5s default.
vi.setConfig({ testTimeout: 30000 });

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
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
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    enabled: true,
    runCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const PARAM_TASK = makeTask({
  id: 'task-params',
  params: [
    { name: 'region', type: 'string', default: 'eu' },
    { name: 'token', type: 'string', required: true },
  ],
});

describe('ScheduledTasksPanel manual run with parameters', () => {
  beforeEach(() => {
    Object.values(hook).forEach((value) => {
      if (typeof value === 'function' && 'mockReset' in value) value.mockReset();
    });
    hook.tasks = [];
    hook.runNow.mockResolvedValue(undefined);
  });

  it('opens the Run with parameters dialog instead of running immediately', () => {
    hook.tasks = [PARAM_TASK];
    render(<ScheduledTasksPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('actions.runNow'));

    expect(screen.getByRole('dialog', { name: 'runParams.title' })).toBeTruthy();
    // Prefilled with the declared defaults.
    expect((screen.getByLabelText('region') as HTMLInputElement).value).toBe('eu');
    expect((screen.getByLabelText('token') as HTMLInputElement).value).toBe('');
    expect(hook.runNow).not.toHaveBeenCalled();
  });

  it('runs with the resolved overrides and closes the dialog', async () => {
    hook.tasks = [PARAM_TASK];
    render(<ScheduledTasksPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('actions.runNow'));
    fireEvent.change(screen.getByLabelText('token'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('runParams.confirm'));

    await waitFor(() => expect(hook.runNow).toHaveBeenCalledWith('task-params', { region: 'eu', token: 'abc' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'runParams.title' })).toBeNull());
  });

  it('keeps a parameterless task on the immediate run path', async () => {
    hook.tasks = [makeTask({ id: 'task-plain' })];
    render(<ScheduledTasksPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('actions.runNow'));

    await waitFor(() => expect(hook.runNow).toHaveBeenCalledWith('task-plain', undefined));
    expect(screen.queryByRole('dialog', { name: 'runParams.title' })).toBeNull();
  });
});
