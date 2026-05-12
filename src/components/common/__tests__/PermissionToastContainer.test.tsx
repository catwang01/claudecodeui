import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import React from 'react';
import { PermissionToastContainer } from '../PermissionToastContainer';
import {
  AwaitingPermissionProvider,
  useAwaitingPermissions,
} from '../../../contexts/AwaitingPermissionContext';
import { act, renderHook } from '@testing-library/react';

function Setup({ selectedSessionId, sessions }: {
  selectedSessionId: string | undefined;
  sessions: Array<{ id: string; name: string; toolName: string; requestId: string }>;
}) {
  return (
    <AwaitingPermissionProvider>
      <Seeder sessions={sessions} />
      <PermissionToastContainer
        selectedSessionId={selectedSessionId}
        getSessionName={(id) => sessions.find((s) => s.id === id)?.name ?? id}
        onNavigate={vi.fn()}
      />
    </AwaitingPermissionProvider>
  );
}

function Seeder({ sessions }: { sessions: Array<{ id: string; toolName: string; requestId: string }> }) {
  const { setAwaitingPermission } = useAwaitingPermissions();
  React.useEffect(() => {
    for (const s of sessions) {
      setAwaitingPermission(s.id, { toolName: s.toolName, requestId: s.requestId });
    }
  }, []);
  return null;
}

test('renders no toasts when map is empty', () => {
  render(
    <AwaitingPermissionProvider>
      <PermissionToastContainer
        selectedSessionId="session-1"
        getSessionName={(id) => id}
        onNavigate={vi.fn()}
      />
    </AwaitingPermissionProvider>,
  );
  expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
});

test('renders toast for background session', async () => {
  render(
    <Setup
      selectedSessionId="session-1"
      sessions={[{ id: 'session-2', name: 'Background', toolName: 'Bash', requestId: 'req-1' }]}
    />,
  );
  expect(await screen.findByText('Background')).toBeInTheDocument();
});

test('does not render toast for selected session', async () => {
  render(
    <Setup
      selectedSessionId="session-1"
      sessions={[{ id: 'session-1', name: 'Current', toolName: 'Bash', requestId: 'req-1' }]}
    />,
  );
  expect(screen.queryByText('Current')).not.toBeInTheDocument();
});

test('shows at most 3 toasts and a collapsed row for the rest', async () => {
  render(
    <Setup
      selectedSessionId="current"
      sessions={[
        { id: 's1', name: 'S1', toolName: 'Bash', requestId: 'r1' },
        { id: 's2', name: 'S2', toolName: 'Bash', requestId: 'r2' },
        { id: 's3', name: 'S3', toolName: 'Bash', requestId: 'r3' },
        { id: 's4', name: 'S4', toolName: 'Bash', requestId: 'r4' },
      ]}
    />,
  );
  expect(await screen.findAllByRole('button', { name: /close/i })).toHaveLength(3);
  expect(await screen.findByText(/and 1 more/i)).toBeInTheDocument();
});
