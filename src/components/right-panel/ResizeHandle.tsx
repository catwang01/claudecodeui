import { useCallback, useEffect, useRef } from 'react';

interface ResizeHandleProps {
  /** Called during mousemove with (currentX - startX) since last event. */
  onResize: (delta: number) => void;
}

export default function ResizeHandle({ onResize }: ResizeHandleProps) {
  const isDraggingRef = useRef(false);
  const lastXRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDraggingRef.current = true;
    lastXRef.current = e.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = e.clientX - lastXRef.current;
      lastXRef.current = e.clientX;
      onResize(delta);
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [onResize]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      onMouseDown={handleMouseDown}
      className="w-1.5 flex-shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-border active:bg-primary/40"
    />
  );
}
