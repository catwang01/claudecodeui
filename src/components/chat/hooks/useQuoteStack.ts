import { useCallback, useMemo, useState } from 'react';

export interface Quote {
  id: string;
  text: string;
  source?: string;
}

const MAX_QUOTES = 10;
const MAX_QUOTE_LENGTH = 4000;

function makeId(): string {
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toBlockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export interface UseQuoteStackResult {
  quotes: Quote[];
  addQuote: (text: string, source?: string) => boolean;
  removeQuote: (id: string) => void;
  clearQuotes: () => void;
  composeWithQuotes: (message: string) => string;
}

export function useQuoteStack(): UseQuoteStackResult {
  const [quotes, setQuotes] = useState<Quote[]>([]);

  const addQuote = useCallback((rawText: string, source?: string): boolean => {
    const text = rawText.trim();
    if (!text) return false;
    const clipped = text.length > MAX_QUOTE_LENGTH ? `${text.slice(0, MAX_QUOTE_LENGTH)}…` : text;
    let added = false;
    setQuotes((prev) => {
      if (prev.length >= MAX_QUOTES) return prev;
      if (prev.some((q) => q.text === clipped && q.source === source)) return prev;
      added = true;
      return [...prev, { id: makeId(), text: clipped, source }];
    });
    return added;
  }, []);

  const removeQuote = useCallback((id: string) => {
    setQuotes((prev) => prev.filter((q) => q.id !== id));
  }, []);

  const clearQuotes = useCallback(() => {
    setQuotes([]);
  }, []);

  const composeWithQuotes = useCallback(
    (message: string): string => {
      if (quotes.length === 0) return message;
      const blocks = quotes
        .map((q) => {
          const header = q.source ? `> _from ${q.source}:_\n` : '';
          return `${header}${toBlockquote(q.text)}`;
        })
        .join('\n\n');
      return message.trim().length > 0 ? `${blocks}\n\n${message}` : blocks;
    },
    [quotes],
  );

  return useMemo(
    () => ({ quotes, addQuote, removeQuote, clearQuotes, composeWithQuotes }),
    [quotes, addQuote, removeQuote, clearQuotes, composeWithQuotes],
  );
}
