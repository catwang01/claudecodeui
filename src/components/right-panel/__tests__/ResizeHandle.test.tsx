import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ResizeHandle from '../ResizeHandle';

describe('ResizeHandle', () => {
  it('renders a visible drag strip', () => {
    render(<ResizeHandle onResize={vi.fn()} />);
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('calls onResize with positive delta when mouse moves right', () => {
    const onResize = vi.fn();
    render(<ResizeHandle onResize={onResize} />);

    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 480 }); // moved left by 20
    fireEvent.mouseUp(document);

    // delta = 480 - 500 = -20 → panel grows (handle moved left)
    expect(onResize).toHaveBeenCalledWith(-20);
  });

  it('stops firing after mouseUp', () => {
    const onResize = vi.fn();
    render(<ResizeHandle onResize={onResize} />);

    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseUp(document);
    fireEvent.mouseMove(document, { clientX: 450 });

    expect(onResize).not.toHaveBeenCalled();
  });
});
