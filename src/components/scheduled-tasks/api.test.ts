import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

vi.mock('../../utils/api', () => ({ authenticatedFetch }));

import { scheduledTasksApi } from './api';

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

describe('scheduledTasksApi.runNow parameter contract (section 12.5)', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
  });

  it('keeps the pre-section-12 request body when no overrides are given', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({ run: { id: 'run-1' } }));
    await scheduledTasksApi.runNow('task-1');
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/scheduled-tasks/task-1/run', {
      method: 'POST',
    });
  });

  it('sends per-run overrides as { params }', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({ run: { id: 'run-1' } }));
    await scheduledTasksApi.runNow('task-1', { params: { region: 'us', threshold: 5, dryRun: true } });
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/scheduled-tasks/task-1/run', {
      method: 'POST',
      body: JSON.stringify({ params: { region: 'us', threshold: 5, dryRun: true } }),
    });
  });

  it('sends an explicit empty params object for a defaults-only run', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({ run: { id: 'run-1' } }));
    await scheduledTasksApi.runNow('task-1', { params: {} });
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/scheduled-tasks/task-1/run', {
      method: 'POST',
      body: '{"params":{}}',
    });
  });
});

describe('scheduledTasksApi.runningCount (section 14.3)', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
  });

  it('reads { count } from GET /running', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({ count: 3 }));

    await expect(scheduledTasksApi.runningCount()).resolves.toBe(3);
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/scheduled-tasks/running');
  });

  it('defaults to 0 for a malformed payload', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({ count: 'many' }));

    await expect(scheduledTasksApi.runningCount()).resolves.toBe(0);
  });

  it('defaults to 0 when the body is missing', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse(null));

    await expect(scheduledTasksApi.runningCount()).resolves.toBe(0);
  });
});

describe('scheduledTasksApi.installPreset parameter contract (section 12.5)', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
  });

  it('forwards { params } next to projectPath and enabled', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      jsonResponse({ preset: { id: 'p' }, tasks: [], created: [], updated: [], skipped: [] }),
    );
    await scheduledTasksApi.installPreset('p-1', { projectPath: '/p/a', params: { region: 'us' } });
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/scheduled-tasks/presets/p-1/install', {
      method: 'POST',
      body: JSON.stringify({ projectPath: '/p/a', enabled: undefined, params: { region: 'us' } }),
    });
  });
});


describe('scheduledTasksApi.running (section 22)', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
  });

  it('reads { count, runs } from GET /running', async () => {
    const runs = [{ id: 'run-1', taskId: 'task-1', taskTitle: 'Task' }];
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({ count: 1, runs }));

    await expect(scheduledTasksApi.running()).resolves.toEqual({ count: 1, runs });
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/scheduled-tasks/running');
  });

  it('defaults to an empty list for a malformed payload', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({ count: 'many', runs: 'nope' }));

    await expect(scheduledTasksApi.running()).resolves.toEqual({ count: 0, runs: [] });
  });
});
