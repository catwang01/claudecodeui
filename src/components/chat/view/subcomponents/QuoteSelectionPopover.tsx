import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

interface QuoteSelectionPopoverProps {
  /** The scrollable messages container. Selections must originate inside this element. */
  containerRef: RefObject<HTMLElement>;
  /** Element refs that should disable the popover when the selection is inside them (e.g. textarea, composer). */
  excludeRefs?: RefObject<HTMLElement | null>[];
  onQuote: (text: string) => void;
}

interface PopoverState {
  top: number;
  left: number;
  text: string;
}

function isNodeInside(node: Node | null, root: HTMLElement | null): boolean {
  if (!node || !root) return false;
  return root === node || root.contains(node);
}

export default function QuoteSelectionPopover({
  containerRef,
  excludeRefs,
  onQuote,
}: QuoteSelectionPopoverProps) {
  const [state, setState] = useState<PopoverState | null>(null);
  const popoverRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const computeSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setState(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const container = containerRef.current;
      if (!container) {
        setState(null);
        return;
      }
      // Anchor must be inside the messages container.
      if (!isNodeInside(range.startContainer, container) || !isNodeInside(range.endContainer, container)) {
        setState(null);
        return;
      }
      // If the selection is inside an excluded element, ignore.
      if (excludeRefs) {
        for (const ref of excludeRefs) {
          if (ref.current && (isNodeInside(range.startContainer, ref.current) || isNodeInside(range.endContainer, ref.current))) {
            setState(null);
            return;
          }
        }
      }
      const text = selection.toString();
      if (!text.trim()) {
        setState(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setState(null);
        return;
      }
      // Position above the selection by default; if near top, place below.
      const popoverHeight = 32;
      const margin = 6;
      const top = rect.top - popoverHeight - margin < 8
        ? rect.bottom + margin
        : rect.top - popoverHeight - margin;
      const left = rect.left + rect.width / 2;
      setState({ top, left, text });
    };

    const handleSelectionChange = () => {
      // Use rAF to coalesce; selectionchange fires very rapidly.
      requestAnimationFrame(computeSelection);
    };

    const handleMouseDown = (event: MouseEvent) => {
      // Clicks on the popover itself shouldn't dismiss before onClick fires.
      if (popoverRef.current && popoverRef.current.contains(event.target as Node)) {
        return;
      }
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mousedown', handleMouseDown, true);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mousedown', handleMouseDown, true);
    };
  }, [containerRef, excludeRefs]);

  if (!state) return null;

  const handleClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onQuote(state.text);
    // Collapse selection after quoting.
    window.getSelection()?.removeAllRanges();
    setState(null);
  };

  return (
    <button
      ref={popoverRef}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleClick}
      className="fixed z-50 -translate-x-1/2 rounded-md border border-border/60 bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-md transition hover:bg-accent"
      style={{ top: state.top, left: state.left }}
    >
      <span className="inline-flex items-center gap-1">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M7 7h4v4H7zM13 7h4v4h-4zM7 13c0 2 1 4 4 4M13 13c0 2 1 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Quote
      </span>
    </button>
  );
}
