import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ParamDef, ScheduledTask } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? key + JSON.stringify(options) : key),
    i18n: { language: 'en' },
  }),
}));

import RunWithParamsDialog from './RunWithParamsDialog';

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
    conflictPolicy: 'skip',
    runCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const DECLARED: ParamDef[] = [
  { name: 'region', type: 'string', default: 'eu', description: 'Deploy region' },
  { name: 'threshold', type: 'number', default: 3 },
  { name: 'dryRun', type: 'boolean', default: false },
];

function renderDialog(
  params: ParamDef[],
  onSubmit: (values: Record<string, unknown>) => Promise<void> = vi.fn().mockResolvedValue(undefined),
) {
  const onClose = vi.fn();
  render(
    <RunWithParamsDialog
      task={makeTask({ params })}
      params={params}
      onClose={onClose}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, onClose };
}

describe('RunWithParamsDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prefills every field with the task default', () => {
    renderDialog(DECLARED);
    expect(screen.getByRole('dialog', { name: 'runParams.title' })).toBeTruthy();
    expect((screen.getByLabelText('region') as HTMLInputElement).value).toBe('eu');
    expect((screen.getByLabelText('threshold') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('dryRun') as HTMLSelectElement).value).toBe('false');
  });

  it('sends typed overrides and omits blank fields so the default applies', async () => {
    const { onSubmit } = renderDialog(DECLARED);

    fireEvent.change(screen.getByLabelText('threshold'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('dryRun'), { target: { value: 'true' } });
    fireEvent.change(screen.getByLabelText('region'), { target: { value: '' } });
    fireEvent.click(screen.getByText('runParams.confirm'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ threshold: 5, dryRun: true }));
  });

  it('blocks submit when a required parameter without a default is blank', async () => {
    const params: ParamDef[] = [{ name: 'token', required: true, description: 'API token' }];
    const { onSubmit } = renderDialog(params);

    fireEvent.click(screen.getByText('runParams.confirm'));

    await waitFor(() => expect(document.body.textContent).toContain('runParams.errors.required'));
    expect(document.body.textContent).toContain('"name":"token"');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a required value once it is filled in', async () => {
    const params: ParamDef[] = [{ name: 'token', required: true }];
    const { onSubmit } = renderDialog(params);

    fireEvent.change(screen.getByLabelText('token'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('runParams.confirm'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ token: 'abc' }));
  });

  it('reports an uncoercible override instead of submitting', async () => {
    const { onSubmit } = renderDialog(DECLARED);
    fireEvent.change(screen.getByLabelText('threshold'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('runParams.confirm'));

    await waitFor(() => expect(document.body.textContent).toContain('runParams.errors.invalid'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and shows the API error when the run request fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('missing_required_param'));
    renderDialog(DECLARED, onSubmit);

    fireEvent.click(screen.getByText('runParams.confirm'));

    await waitFor(() => expect(document.body.textContent).toContain('missing_required_param'));
    expect(screen.getByRole('dialog', { name: 'runParams.title' })).toBeTruthy();
  });

  it('closes via the cancel button', () => {
    const { onClose } = renderDialog(DECLARED);
    fireEvent.click(screen.getByText('actions.cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  // Review N2: __proto__ is a valid parameter name; the dialog used to read
  // Object.prototype back from its inputs map and crash on raw.trim().
  it('runs a __proto__-named parameter without crashing', async () => {
    const params: ParamDef[] = [{ name: '__proto__', type: 'string', default: 'x' }];
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderDialog(params, onSubmit);

    expect(screen.getByRole('dialog', { name: 'runParams.title' })).toBeTruthy();
    const input = screen.getByLabelText('__proto__') as HTMLInputElement;
    expect(input.value).toBe('x');

    fireEvent.change(input, { target: { value: 'y' } });
    fireEvent.click(screen.getByText('runParams.confirm'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const overrides = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(overrides, '__proto__')).toBe(true);
    expect(overrides['__proto__']).toBe('y');
    expect(JSON.stringify(overrides)).toBe('{"__proto__":"y"}');
  });

  it('prefills a boolean default stored as 1 as the canonical true (review N5)', () => {
    renderDialog([{ name: 'dryRun', type: 'boolean', default: 1 }]);
    expect((screen.getByLabelText('dryRun') as HTMLSelectElement).value).toBe('true');
  });
});
