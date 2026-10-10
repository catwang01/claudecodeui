import { afterEach, describe, expect, it, vi } from 'vitest';

const summaryRefreshMocks = vi.hoisted(() => ({
  waitForCopilotSessionSummary: vi.fn(),
  getProjects: vi.fn(),
}));

vi.mock('./modules/providers/list/copilot/copilot-session-synchronizer.provider.js', () => ({
  waitForCopilotSessionSummary: summaryRefreshMocks.waitForCopilotSessionSummary,
}));

vi.mock('./projects.js', () => ({
  getProjects: summaryRefreshMocks.getProjects,
}));

import * as copilotSdk from './copilot-sdk.js';

const { normalizeCopilotModels } = copilotSdk;

afterEach(() => {
  vi.clearAllMocks();
});

describe('normalizeCopilotModels', () => {
  it('maps SDK model metadata to unique selector options', () => {
    expect(normalizeCopilotModels([
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.5', name: 'Duplicate' },
      { id: 'claude-sonnet-4.6', name: '' },
      { name: 'Missing ID' },
    ])).toEqual([
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'claude-sonnet-4.6', label: 'claude-sonnet-4.6' },
    ]);
  });
});

describe('refreshCopilotSessionSummary', () => {
  it('broadcasts updated projects after the completed session gets a native summary', async () => {
    summaryRefreshMocks.waitForCopilotSessionSummary.mockResolvedValue('cloud-session');
    summaryRefreshMocks.getProjects.mockResolvedValue([{ path: 'C:\\repo' }]);
    const messages = [];

    const refreshed = await copilotSdk.refreshCopilotSessionSummary(
      'native-session',
      (message) => messages.push(message)
    );

    expect(refreshed).toBe(true);
    expect(messages).toEqual([{
      type: 'projects_updated',
      projects: [{ path: 'C:\\repo' }],
      timestamp: expect.any(String),
      changeType: 'change',
      watchProvider: 'copilot',
      updatedSessionIds: ['cloud-session'],
      batched: false,
    }]);
  });
});
