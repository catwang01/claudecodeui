import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'count' in options ? `${key}:${String(options.count)}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../hooks/useRunningScheduledTasks', () => ({
  useRunningScheduledTasks: () => ({ count: state.count, refresh: vi.fn() }),
}));

vi.mock('./ScheduledTasksPanel', () => ({
  default: ({ runningCount }: { runningCount?: number }) => (
    <div data-testid="scheduled-tasks-panel" data-running-count={String(runningCount)} />
  ),
}));

import ScheduledTasksLauncher from './ScheduledTasksLauncher';

// Rendering these trees is cheap, but CI/dev boxes can be heavily loaded, so
// keep a generous per-test budget instead of relying on the 5s default.
vi.setConfig({ testTimeout: 30000 });

describe('ScheduledTasksLauncher running count badge', () => {
  beforeEach(() => {
    state.count = 0;
  });

  it('renders no badge while nothing is running', () => {
    render(<ScheduledTasksLauncher />);

    expect(screen.queryByTestId('running-count-badge')).toBeNull();
  });

  it('shows the count on both the desktop and mobile launcher buttons', () => {
    state.count = 3;
    render(<ScheduledTasksLauncher />);

    const badges = screen.getAllByLabelText('launcher.running:3');
    expect(badges).toHaveLength(2);
    badges.forEach((badge) => {
      expect(badge.textContent).toBe('3');
      expect(badge.closest('button')).not.toBeNull();
    });
  });

  it('passes the running count to the panel it opens', () => {
    state.count = 2;
    render(<ScheduledTasksLauncher />);
    expect(screen.queryByTestId('scheduled-tasks-panel')).toBeNull();

    // Desktop button first, then the mobile one; both mount the same panel.
    fireEvent.click(screen.getAllByRole('button')[0]);

    const panel = screen.getByTestId('scheduled-tasks-panel');
    expect(panel.getAttribute('data-running-count')).toBe('2');
  });
});
