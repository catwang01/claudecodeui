import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Preset, PresetTask, ScheduledTask } from '../types';

const api = vi.hoisted(() => ({
  listPresets: vi.fn(),
  listProjectOptions: vi.fn(),
  installPreset: vi.fn(),
  enablePreset: vi.fn(),
  disablePreset: vi.fn(),
  removePreset: vi.fn(),
  createPreset: vi.fn(),
  list: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? key + JSON.stringify(options) : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../api', () => ({ scheduledTasksApi: api }));

import PresetsSection from './PresetsSection';

function makePresetTask(id: string, title: string): PresetTask {
  return {
    id,
    presetId: 'builtin-starter',
    title,
    description: null,
    prompt: 'Do the thing',
    provider: 'claude',
    model: null,
    kind: 'daily',
    rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    command: null,
    commandTimeoutSeconds: null,
    position: 0,
  };
}

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'builtin-starter',
    source: 'builtin',
    name: 'Starter kit',
    description: 'A few useful tasks',
    icon: null,
    version: '1',
    enabled: false,
    projectPath: null,
    taskCount: 1,
    installedProjects: [],
    tasks: [makePresetTask('tpl-1', 'Nightly audit')],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(id: string, title: string): ScheduledTask {
  return {
    id,
    title,
    prompt: 'Do the thing',
    projectPath: '/p/a',
    provider: 'claude',
    model: null,
    command: null,
    commandTimeoutSeconds: null,
    kind: 'daily',
    rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    nextRunAt: '2026-01-02T09:00:00.000Z',
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    enabled: true,
    runCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const textWith = (needle: string) => (content: string) => content.includes(needle);

const PROJECT = { value: '/p/a', label: 'Project A' };

async function waitForProjectSelected() {
  await waitFor(() =>
    expect((screen.getByLabelText('presets.project.label') as HTMLSelectElement).value).toBe(PROJECT.value),
  );
}

describe('PresetsSection', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    api.listProjectOptions.mockResolvedValue([PROJECT]);
  });

  it('lists the builtin catalog and custom presets with a collapsible task preview', async () => {
    const builtin = makePreset({
      id: 'builtin-starter',
      name: 'Starter kit',
      taskCount: 4,
      tasks: [
        makePresetTask('tpl-1', 'Task one'),
        makePresetTask('tpl-2', 'Task two'),
        makePresetTask('tpl-3', 'Task three'),
        makePresetTask('tpl-4', 'Task four'),
      ],
    });
    const foreign = makePreset({
      id: 'custom-1',
      source: 'custom',
      name: 'My bundle',
      projectPath: '/p/other',
      installedProjects: ['/p/other'],
      enabled: true,
    });
    const installedHere = makePreset({
      id: 'custom-2',
      source: 'custom',
      name: 'Bundle two',
      projectPath: '/p/a',
      installedProjects: ['/p/a'],
      enabled: true,
    });
    api.listPresets.mockResolvedValue([builtin, foreign, installedHere]);

    render(<PresetsSection />);

    await waitFor(() => expect(screen.getByText('Starter kit')).toBeTruthy());
    expect(screen.getByText('My bundle')).toBeTruthy();
    expect(screen.getByText('Bundle two')).toBeTruthy();
    expect(screen.getByText('presets.catalogTitle')).toBeTruthy();
    expect(screen.getByText('presets.customTitle')).toBeTruthy();
    expect(screen.getAllByText('presets.source.custom').length).toBe(2);
    await waitForProjectSelected();
    // Installed in the selected project -> exact badge; installed elsewhere -> count.
    expect(screen.getByText('presets.installed')).toBeTruthy();
    expect(screen.getByText('presets.installedIn' + JSON.stringify({ count: 1 }))).toBeTruthy();
    expect(screen.getAllByText(textWith('presets.taskCount')).length).toBeGreaterThan(0);

    // Collapsed shows the first three templates plus a "more" hint.
    expect(screen.getByText('Task three')).toBeTruthy();
    expect(screen.queryByText('Task four')).toBeNull();
    expect(screen.getByText(textWith('presets.moreTasks'))).toBeTruthy();

    // One toggle per preset card; the builtin catalog renders first.
    screen.getAllByLabelText('presets.actions.showTasks')[0].click();

    await waitFor(() => expect(screen.getByText('Task four')).toBeTruthy());
    expect(screen.queryByText(textWith('presets.moreTasks'))).toBeNull();
  });

  it('installs a preset into the picked project and reports the summary', async () => {
    const preset = makePreset({ enabled: false });
    api.listPresets.mockResolvedValue([preset]);
    api.installPreset.mockResolvedValue({
      preset,
      tasks: [],
      created: ['builtin-starter:tpl-1'],
      updated: [],
      skipped: [],
    });

    render(<PresetsSection />);
    await waitFor(() => expect(screen.getByText('Starter kit')).toBeTruthy());
    await waitForProjectSelected();

    screen.getByLabelText('presets.actions.install').click();

    await waitFor(() => expect(screen.getByText('presets.installDialog.confirm')).toBeTruthy());
    screen.getByText('presets.installDialog.confirm').click();

    await waitFor(() =>
      expect(api.installPreset).toHaveBeenCalledWith('builtin-starter', {
        projectPath: '/p/a',
        enabled: false,
      }),
    );
    await waitFor(() => expect(screen.getByText(textWith('presets.result.installed'))).toBeTruthy());
    // The catalog is re-read after a mutation.
    await waitFor(() => expect(api.listPresets.mock.calls.length).toBeGreaterThan(1));
  });

  it('enables a paused preset through the whole-preset switch', async () => {
    const preset = makePreset({ id: 'builtin-starter', enabled: false });
    api.listPresets.mockResolvedValue([preset]);
    api.enablePreset.mockResolvedValue({ preset: { ...preset, enabled: true }, tasks: [] });

    render(<PresetsSection />);
    await waitFor(() => expect(screen.getByText('Starter kit')).toBeTruthy());
    await waitForProjectSelected();

    screen.getByLabelText('presets.actions.enable').click();

    await waitFor(() => expect(api.enablePreset).toHaveBeenCalledWith('builtin-starter', { projectPath: '/p/a' }));
    await waitFor(() => expect(api.listPresets.mock.calls.length).toBeGreaterThan(1));
  });

  it('deletes a custom preset, purging its installed tasks by default', async () => {
    const preset = makePreset({
      id: 'custom-1',
      source: 'custom',
      name: 'My bundle',
      projectPath: '/p/a',
      installedProjects: ['/p/a'],
    });
    api.listPresets.mockResolvedValue([preset]);
    api.removePreset.mockResolvedValue({ id: 'custom-1', deleted: true, removedTasks: 2 });

    render(<PresetsSection />);
    await waitFor(() => expect(screen.getByText('My bundle')).toBeTruthy());
    await waitForProjectSelected();

    screen.getByLabelText('presets.actions.delete').click();

    await waitFor(() => expect(screen.getByText('presets.deleteDialog.confirm')).toBeTruthy());
    screen.getByText('presets.deleteDialog.confirm').click();

    await waitFor(() =>
      expect(api.removePreset).toHaveBeenCalledWith('custom-1', { purge: true, projectPath: '/p/a' }),
    );
    await waitFor(() => expect(screen.getByText(textWith('presets.result.removed'))).toBeTruthy());
  });

  it('uninstalls a builtin preset without purging real tasks', async () => {
    const preset = makePreset({ id: 'builtin-starter' });
    api.listPresets.mockResolvedValue([preset]);
    api.removePreset.mockResolvedValue({ id: 'builtin-starter', deleted: true, removedTasks: 0 });

    render(<PresetsSection />);
    await waitFor(() => expect(screen.getByText('Starter kit')).toBeTruthy());
    await waitForProjectSelected();

    screen.getByLabelText('presets.actions.uninstall').click();

    await waitFor(() => expect(screen.getByText('presets.uninstallDialog.confirm')).toBeTruthy());
    screen.getByText('presets.uninstallDialog.confirm').click();

    await waitFor(() =>
      expect(api.removePreset).toHaveBeenCalledWith('builtin-starter', { purge: false, projectPath: '/p/a' }),
    );
    await waitFor(() => expect(screen.getByText('presets.result.uninstalled')).toBeTruthy());
  });

  it('creates a custom preset from the selected tasks of a project', async () => {
    api.listPresets.mockResolvedValue([makePreset()]);
    api.list.mockResolvedValue([makeTask('task-1', 'Task alpha'), makeTask('task-2', 'Task beta')]);
    api.createPreset.mockResolvedValue(
      makePreset({ id: 'custom-9', source: 'custom', name: 'Maintenance', projectPath: '/p/a' }),
    );

    render(<PresetsSection />);
    await waitFor(() => expect(screen.getByText('Starter kit')).toBeTruthy());
    await waitForProjectSelected();

    screen.getByText('presets.actions.newPreset').click();
    await waitFor(() => expect(screen.getByText('presets.newDialog.confirm')).toBeTruthy());

    const nameInput = screen.getByLabelText('presets.newDialog.name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Maintenance' } });

    await waitFor(() => expect(screen.getByText('Task alpha')).toBeTruthy());
    screen.getAllByRole('checkbox')[0].click();

    await waitFor(() => expect(screen.getByText('presets.newDialog.selected' + JSON.stringify({ count: 1 }))).toBeTruthy());
    screen.getByText('presets.newDialog.confirm').click();

    await waitFor(() =>
      expect(api.createPreset).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Maintenance',
          projectPath: '/p/a',
          taskIds: ['task-1'],
        }),
      ),
    );
  });

  it('shows an error with retry when the catalog cannot be loaded', async () => {
    // No projects: keeps the section scoped to '' so the first (failing) load is
    // not immediately replaced by a project-scoped retry.
    api.listProjectOptions.mockResolvedValue([]);
    api.listPresets.mockRejectedValueOnce(new Error('boom'));
    api.listPresets.mockResolvedValue([makePreset()]);

    render(<PresetsSection />);

    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    screen.getByText('actions.retry').click();

    await waitFor(() => expect(screen.getByText('Starter kit')).toBeTruthy());
  });

  it('shows the empty state when the catalog has no presets', async () => {
    api.listPresets.mockResolvedValue([]);

    render(<PresetsSection />);

    await waitFor(() => expect(screen.getByText('presets.empty.title')).toBeTruthy());
  });
});
