import { fireEvent, render, screen, within } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { AwaitingPermissionProvider } from '../../../../../contexts/AwaitingPermissionContext';
import type { Project } from '../../../../../types/app';
import type { SessionWithProvider } from '../../../types/types';
import SidebarSessionItem from '../SidebarSessionItem';

// Stub translator: returning the key makes every assertion below independent of
// locale files, while still matching the component's t('tooltips.forkSession') call.
const t = ((key: string) => key) as unknown as TFunction;

const project: Project = {
  name: 'demo-project',
  displayName: 'Demo Project',
  fullPath: '/tmp/demo-project',
};

const session: SessionWithProvider = {
  id: 'session-1',
  summary: 'First session',
  lastActivity: new Date().toISOString(),
  messageCount: 2,
  __provider: 'claude',
};

function mobileForkControl(container: HTMLElement): HTMLButtonElement {
  // The mobile branch is the only .md:hidden subtree in this component.
  const mobileRoot = container.querySelector<HTMLElement>('.md\\:hidden');
  if (!mobileRoot) throw new Error('mobile branch (.md:hidden) not found');
  const button = mobileRoot.querySelector<HTMLButtonElement>('button[title="tooltips.forkSession"]');
  if (!button) throw new Error('mobile fork control not found');
  return button;
}

function desktopForkControl(container: HTMLElement): HTMLButtonElement {
  // The desktop hover controls live in the .hidden.md:block subtree.
  const desktopRoot = container.querySelector<HTMLElement>('.hidden.md\\:block');
  if (!desktopRoot) throw new Error('desktop branch (.hidden.md:block) not found');
  const button = desktopRoot.querySelector<HTMLButtonElement>('button[title="tooltips.forkSession"]');
  if (!button) throw new Error('desktop fork control not found');
  return button;
}

function renderItem(overrides: { isForking?: boolean } = {}) {
  const onForkSession = vi.fn();
  const onSessionSelect = vi.fn();
  const onProjectSelect = vi.fn();

  const view = render(
    <AwaitingPermissionProvider>
      <SidebarSessionItem
        variant="default"
        project={project}
        session={session}
        selectedSession={null}
        currentTime={new Date()}
        editingSession={null}
        editingSessionName=""
        onEditingSessionNameChange={vi.fn()}
        onStartEditingSession={vi.fn()}
        onCancelEditingSession={vi.fn()}
        onSaveEditingSession={vi.fn()}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={vi.fn()}
        onForkSession={onForkSession}
        isForking={overrides.isForking}
        t={t}
      />
    </AwaitingPermissionProvider>,
  );

  return { ...view, onForkSession, onSessionSelect, onProjectSelect };
}

test('renders the fork control in the default variant mobile and desktop branches', () => {
  const { container } = renderItem();

  // Both responsive branches are always mounted (CSS hides one of them).
  expect(screen.getAllByTitle('tooltips.forkSession')).toHaveLength(2);
  expect(mobileForkControl(container)).toBeInTheDocument();
  expect(desktopForkControl(container)).toBeInTheDocument();
  expect(desktopForkControl(container)).toHaveTextContent('');
});

test('mobile fork control calls onForkSession with the provider and stops row selection', () => {
  const { container, onForkSession, onSessionSelect, onProjectSelect } = renderItem();

  fireEvent.click(mobileForkControl(container));

  expect(onForkSession).toHaveBeenCalledTimes(1);
  expect(onForkSession).toHaveBeenCalledWith(project.name, session.id, session.__provider);
  // stopPropagation must prevent the enclosing mobile row handler from firing.
  expect(onSessionSelect).not.toHaveBeenCalled();
  expect(onProjectSelect).not.toHaveBeenCalled();
});

test('negative control: clicking the mobile row itself selects the session', () => {
  // Without this probe a missing row handler would make the assertion above vacuous.
  const { container, onSessionSelect, onProjectSelect } = renderItem();
  const mobileRoot = container.querySelector<HTMLElement>('.md\\:hidden');
  if (!mobileRoot) throw new Error('mobile branch (.md:hidden) not found');

  fireEvent.click(within(mobileRoot).getByText('First session'));

  expect(onProjectSelect).toHaveBeenCalledWith(project);
  expect(onSessionSelect).toHaveBeenCalledWith(session, project.name);
});

test('desktop fork control calls onForkSession with the provider', () => {
  const { container, onForkSession } = renderItem();

  fireEvent.click(desktopForkControl(container));

  expect(onForkSession).toHaveBeenCalledTimes(1);
  expect(onForkSession).toHaveBeenCalledWith(project.name, session.id, session.__provider);
});

test('fork controls are disabled and show a spinner while isForking', () => {
  renderItem({ isForking: true });

  const controls = screen.getAllByTitle('tooltips.forkSession');
  expect(controls).toHaveLength(2);
  for (const control of controls) {
    expect(control).toBeDisabled();
    expect(control.querySelector('svg.animate-spin')).not.toBeNull();
  }
});

// Stable callback identities so the only prop that changes across the re-render
// is isForking -- this isolates sessionItemPropsAreEqual.
const stableCallbacks = {
  onEditingSessionNameChange: vi.fn(),
  onStartEditingSession: vi.fn(),
  onCancelEditingSession: vi.fn(),
  onSaveEditingSession: vi.fn(),
  onProjectSelect: vi.fn(),
  onSessionSelect: vi.fn(),
  onDeleteSession: vi.fn(),
  onForkSession: vi.fn(),
};

function ForkingHarness() {
  const [isForking, setIsForking] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setIsForking(true)}>
        start-forking
      </button>
      <SidebarSessionItem
        variant="default"
        project={project}
        session={session}
        selectedSession={null}
        currentTime={new Date()}
        editingSession={null}
        editingSessionName=""
        isForking={isForking}
        t={t}
        {...stableCallbacks}
      />
    </>
  );
}

test('memo comparator forwards isForking so the spinner reaches the row', () => {
  render(
    <AwaitingPermissionProvider>
      <ForkingHarness />
    </AwaitingPermissionProvider>,
  );

  expect(screen.getAllByTitle('tooltips.forkSession')[0]).not.toBeDisabled();

  fireEvent.click(screen.getByText('start-forking'));

  // If sessionItemPropsAreEqual ignored isForking, memo would bail out and the
  // control would stay enabled.
  const controls = screen.getAllByTitle('tooltips.forkSession');
  expect(controls[0]).toBeDisabled();
  expect(controls[1]).toBeDisabled();
  expect(controls[0].querySelector('svg.animate-spin')).not.toBeNull();
});
