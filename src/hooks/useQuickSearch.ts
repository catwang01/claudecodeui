import { useCallback, useEffect, useRef, useState } from 'react';

export function useQuickSearch() {
  const [isOpen, setIsOpen] = useState(false);
  const lastSpaceTimeRef = useRef<number>(0);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        close();
        return;
      }

      if (e.key !== ' ') {
        lastSpaceTimeRef.current = 0;
        return;
      }

      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        (activeEl instanceof HTMLElement && activeEl.isContentEditable)
      ) {
        lastSpaceTimeRef.current = 0;
        return;
      }

      const now = Date.now();
      if (now - lastSpaceTimeRef.current < 400) {
        e.preventDefault();
        lastSpaceTimeRef.current = 0;
        open();
      } else {
        lastSpaceTimeRef.current = now;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, open, close]);

  return { isOpen, open, close };
}
