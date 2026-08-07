import { describe, expect, it } from 'vitest';
import { normalizeCopilotModels } from './copilot-sdk.js';

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
