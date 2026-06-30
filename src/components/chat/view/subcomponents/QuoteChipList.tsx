import type { Quote } from '../../hooks/useQuoteStack';

interface QuoteChipListProps {
  quotes: Quote[];
  onRemove: (id: string) => void;
  onClear: () => void;
}

function previewOf(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export default function QuoteChipList({ quotes, onRemove, onClear }: QuoteChipListProps) {
  if (quotes.length === 0) return null;
  return (
    <div className="mb-2 rounded-xl bg-muted/40 p-2">
      <div className="mb-1 flex items-center justify-between px-1 text-xs text-muted-foreground">
        <span>{quotes.length} 引用</span>
        {quotes.length > 1 && (
          <button
            type="button"
            onClick={onClear}
            className="rounded px-1 hover:text-foreground"
          >
            清空
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {quotes.map((q) => (
          <div
            key={q.id}
            className="group flex items-start gap-2 rounded-lg border-l-2 border-primary/50 bg-card/60 px-2 py-1.5 text-sm"
          >
            <div className="min-w-0 flex-1">
              {q.source && (
                <div className="mb-0.5 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                  {q.source}
                </div>
              )}
              <div className="line-clamp-2 break-words text-xs text-foreground/80">
                {previewOf(q.text)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onRemove(q.id)}
              aria-label="Remove quote"
              className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground group-hover:opacity-100"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
