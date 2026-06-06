import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import RightPanel from '../RightPanel';

// Stub heavy components so tests stay fast
vi.mock('../../../components/file-tree/view/FileTree', () => ({
  default: () => <div data-testid="file-tree" />,
}));
vi.mock('../../../components/git-panel/view/GitPanel', () => ({
  default: () => <div data-testid="git-panel" />,
}));

const baseProps = {
  activeTab: 'files' as const,
  onTabChange: vi.fn(),
  onClose: vi.fn(),
  selectedProject: null,
};

describe('RightPanel', () => {
  it('shows "Files" and "Git" tab buttons', () => {
    render(<RightPanel {...baseProps} />);
    expect(screen.getByRole('button', { name: /files/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /git/i })).toBeInTheDocument();
  });

  it('renders FileTree when activeTab is "files"', () => {
    render(<RightPanel {...baseProps} activeTab="files" />);
    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
  });

  it('renders GitPanel when activeTab is "git"', () => {
    render(<RightPanel {...baseProps} activeTab="git" />);
    expect(screen.getByTestId('git-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tree')).not.toBeInTheDocument();
  });

  it('calls onTabChange when Git tab is clicked', () => {
    const onTabChange = vi.fn();
    render(<RightPanel {...baseProps} onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole('button', { name: /git/i }));
    expect(onTabChange).toHaveBeenCalledWith('git');
  });

  it('calls onClose when ✕ button is clicked', () => {
    const onClose = vi.fn();
    render(<RightPanel {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
