import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { Preset, PresetTask } from '../types';
import { describePresetTask, isPresetInstalledIn, normalizePresetPath } from './presets';

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? key + JSON.stringify(options) : key) as unknown as TFunction;

function makeTask(overrides: Partial<PresetTask> = {}): PresetTask {
  return {
    id: 'tpl-1',
    presetId: 'p1',
    title: 'Nightly audit',
    description: null,
    prompt: 'Audit dependencies',
    provider: 'claude',
    model: null,
    kind: 'interval',
    rule: { kind: 'interval', everySeconds: 7200 },
    command: null,
    commandTimeoutSeconds: null,
    position: 0,
    ...overrides,
  };
}

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'p1',
    source: 'custom',
    name: 'Bundle',
    description: null,
    icon: null,
    version: null,
    enabled: false,
    projectPath: '/p/a',
    taskCount: 1,
    installedProjects: [],
    tasks: [makeTask()],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('preset path helpers', () => {
  it('normalizes whitespace and trailing separators without touching the root', () => {
    expect(normalizePresetPath('  /p/a/  ')).toBe('/p/a');
    expect(normalizePresetPath('/p/a///')).toBe('/p/a');
    expect(normalizePresetPath('/')).toBe('/');
    expect(normalizePresetPath(null)).toBe('');
    expect(normalizePresetPath(undefined)).toBe('');
  });

  it('reports installed state across separator differences only for a real project', () => {
    const preset = makePreset({ installedProjects: ['/p/a/'] });
    expect(isPresetInstalledIn(preset, '/p/a')).toBe(true);
    expect(isPresetInstalledIn(preset, '/p/b')).toBe(false);
    expect(isPresetInstalledIn(preset, '')).toBe(false);
    expect(isPresetInstalledIn(makePreset({ installedProjects: [] }), '/p/a')).toBe(false);
  });
});

describe('describePresetTask', () => {
  it('describes the template rule with the scheduledTasks namespace', () => {
    expect(describePresetTask(makeTask(), t)).toBe(
      'describe.interval' + JSON.stringify({ value: 2, unit: 'rule.interval.units.hours' }),
    );
  });
});
