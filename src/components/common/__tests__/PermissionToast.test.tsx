import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { PermissionToast } from '../PermissionToast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('renders session name and tool name', () => {
  render(
    <PermissionToast
      sessionName="My Session"
      toolName="Bash"
      onNavigate={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  expect(screen.getByText('My Session')).toBeInTheDocument();
  expect(screen.getByText(/Bash/)).toBeInTheDocument();
});

test('calls onDismiss when X button is clicked', async () => {
  const onDismiss = vi.fn();
  render(
    <PermissionToast
      sessionName="My Session"
      toolName="Bash"
      onNavigate={vi.fn()}
      onDismiss={onDismiss}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: /close/i }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('calls onNavigate when toast body is clicked', async () => {
  const onNavigate = vi.fn();
  render(
    <PermissionToast
      sessionName="My Session"
      toolName="Bash"
      onNavigate={onNavigate}
      onDismiss={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByText('My Session'));
  expect(onNavigate).toHaveBeenCalledTimes(1);
});

test('calls onDismiss after 8 seconds', () => {
  const onDismiss = vi.fn();
  render(
    <PermissionToast
      sessionName="My Session"
      toolName="Bash"
      onNavigate={vi.fn()}
      onDismiss={onDismiss}
    />,
  );
  act(() => vi.advanceTimersByTime(8000));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('does not call onDismiss before 8 seconds', () => {
  const onDismiss = vi.fn();
  render(
    <PermissionToast
      sessionName="My Session"
      toolName="Bash"
      onNavigate={vi.fn()}
      onDismiss={onDismiss}
    />,
  );
  act(() => vi.advanceTimersByTime(7999));
  expect(onDismiss).not.toHaveBeenCalled();
});
