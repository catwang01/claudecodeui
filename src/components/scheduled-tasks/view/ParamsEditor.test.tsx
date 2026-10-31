import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MAX_PARAMS, createParamDraft, type ParamDraft } from '../utils/params';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? key + JSON.stringify(options) : key),
    i18n: { language: 'en' },
  }),
}));

import ParamsEditor from './ParamsEditor';

// Rendering these trees is cheap, but CI/dev boxes can be heavily loaded, so
// keep a generous per-test budget instead of relying on the 5s default.
vi.setConfig({ testTimeout: 30000 });

function Harness({ initial = [] }: { initial?: ParamDraft[] }) {
  const [drafts, setDrafts] = useState<ParamDraft[]>(initial);
  return <ParamsEditor drafts={drafts} onChange={setDrafts} />;
}

describe('ParamsEditor', () => {
  it('adds and removes parameter rows', () => {
    render(<Harness />);
    expect(screen.getByText('editor.params.none')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'editor.params.add' }));
    expect(screen.getByLabelText('editor.params.name')).toBeTruthy();
    expect(screen.getByLabelText('editor.params.type')).toBeTruthy();
    expect(screen.getByLabelText('editor.params.default')).toBeTruthy();
    expect(screen.getByLabelText('editor.params.description')).toBeTruthy();
    expect(screen.getByLabelText('editor.params.required')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'editor.params.remove' }));
    expect(screen.queryByLabelText('editor.params.name')).toBeNull();
    expect(screen.getByText('editor.params.none')).toBeTruthy();
  });

  it('previews the derived SCHEDULED_TASK_PARAM_ env var once the name is valid', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'editor.params.add' }));
    expect(screen.getByText('editor.params.envPlaceholder')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('editor.params.name'), { target: { value: 'dryRun' } });
    expect(screen.getByText('SCHEDULED_TASK_PARAM_DRYRUN')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('editor.params.name'), { target: { value: '1bad' } });
    expect(screen.queryByText('SCHEDULED_TASK_PARAM_1BAD')).toBeNull();
  });

  it('clears the default when the parameter becomes required (section 12.1)', () => {
    render(<Harness initial={[createParamDraft({ name: 'region', default: 'eu' })]} />);
    expect((screen.getByLabelText('editor.params.default') as HTMLInputElement).value).toBe('eu');

    fireEvent.click(screen.getByLabelText('editor.params.required'));
    expect((screen.getByLabelText('editor.params.default') as HTMLInputElement).value).toBe('');
  });

  it('renders a server-supplied required parameter that still has a default', () => {
    // The editor no longer treats this combination as invalid (review N1): it
    // must load as-is so the task can be re-saved.
    render(<Harness initial={[createParamDraft({ name: 'region', default: 'eu', required: true })]} />);
    expect((screen.getByLabelText('editor.params.required') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('editor.params.default') as HTMLInputElement).value).toBe('eu');
  });

  it('switches the default control to true/false for boolean parameters', () => {
    render(<Harness initial={[createParamDraft({ name: 'dryRun', default: 'eu' })]} />);

    fireEvent.change(screen.getByLabelText('editor.params.type'), { target: { value: 'boolean' } });
    const select = screen.getByLabelText('editor.params.default') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    // Changing the type cannot keep the old default.
    expect(select.value).toBe('');

    fireEvent.change(select, { target: { value: 'false' } });
    expect(select.value).toBe('false');
  });

  it('disables adding rows at the 32 parameter limit', () => {
    const full = Array.from({ length: MAX_PARAMS }, (_, index) => createParamDraft({ name: 'p' + index }));
    render(<Harness initial={full} />);
    expect((screen.getByRole('button', { name: 'editor.params.add' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not derive an env var from a name with surrounding whitespace (review N5)', () => {
    // The server rejects such a name instead of trimming it into a different one.
    render(<Harness initial={[createParamDraft({ name: ' region ' })]} />);
    expect((screen.getByLabelText('editor.params.name') as HTMLInputElement).value).toBe(' region ');
    expect(screen.queryByText('SCHEDULED_TASK_PARAM_REGION')).toBeNull();
    expect(screen.getByText('editor.params.envPlaceholder')).toBeTruthy();
  });

  it('shows the section 13.1 built-ins and the no-hardcode hint', () => {
    render(<Harness />);

    expect(screen.getByText('editor.params.builtins.title')).toBeTruthy();
    expect(screen.getByText('editor.params.builtins.hint')).toBeTruthy();
    expect(screen.getByText('editor.params.builtins.CWD')).toBeTruthy();
    expect(screen.getByText('SCHEDULED_TASK_TITLE')).toBeTruthy();
    expect(screen.getByText('SCHEDULED_TASK_CWD')).toBeTruthy();
    expect(screen.getByText('SCHEDULED_TASK_PROJECT')).toBeTruthy();
  });
});
