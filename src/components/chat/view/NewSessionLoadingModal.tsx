import { createPortal } from 'react-dom';

interface NewSessionLoadingModalProps {
  isVisible: boolean;
  error: string | null;
  onRetry: () => void;
  onCancel?: () => void;
}

export function NewSessionLoadingModal({ isVisible, error, onRetry, onCancel }: NewSessionLoadingModalProps) {
  if (!isVisible) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onCancel}
        role={onCancel ? 'button' : undefined}
        aria-label={onCancel ? 'Cancel session creation' : undefined}
      />
      <div className="relative flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-10 py-8 shadow-2xl text-center min-w-[220px] max-w-[320px]">
        {!error ? (
          <>
            <svg
              className="h-8 w-8 animate-spin text-primary"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <p className="text-sm font-medium text-foreground">Creating session</p>
            <p className="text-xs text-muted-foreground">Please wait...</p>
          </>
        ) : (
          <>
            <svg
              className="h-8 w-8 text-destructive"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4m0 4h.01" />
            </svg>
            <p className="text-sm font-medium text-foreground">Session creation failed</p>
            <p className="text-xs text-muted-foreground">{error}</p>
            <button
              onClick={onRetry}
              className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Retry
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
