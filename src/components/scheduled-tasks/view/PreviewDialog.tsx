import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import type { ScheduledTask, TaskPreview } from '../types';

type PreviewDialogProps = {
  task: ScheduledTask;
  preview: TaskPreview | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
};

/** §20: shows the script-gate decision without having called the agent. */
export default function PreviewDialog({ task, preview, isLoading, error, onClose }: PreviewDialogProps) {
  const { t } = useTranslation('scheduledTasks');
  const decision = preview?.decision ?? 'run';

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('previewDialog.title', { title: task.title })}
    >
      <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">
            {t('previewDialog.title', { title: task.title })}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('actions.close')}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
          {isLoading && <p className="text-muted-foreground">{t('previewDialog.running')}</p>}
          {error && <p className="text-destructive">{error}</p>}
          {!isLoading && !error && preview && (
            <>
              <p>
                {t('previewDialog.decision')}:{' '}
                <span className="font-medium">{t('previewDialog.decisionValue.' + decision)}</span>
              </p>
              {decision === 'skip' && (
                <p className="text-muted-foreground">
                  {t('previewDialog.reason')}: {preview.reason ?? t('runs.noReason')}
                </p>
              )}
              {decision === 'error' && <p className="text-destructive">{preview.error ?? t('status.error')}</p>}
              {decision === 'run' && (
                <div>
                  <div className="mb-1 font-medium">{t('runs.effectivePrompt')}</div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs">
                    {preview.effectivePrompt ?? task.prompt}
                  </pre>
                </div>
              )}
              {preview.scriptOutput ? (
                <div>
                  <div className="mb-1 font-medium">{t('runs.scriptOutput')}</div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs">
                    {preview.scriptOutput}
                  </pre>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" size="sm" onClick={onClose}>
            {t('actions.close')}
          </Button>
        </div>
      </div>
    </div>
  );
}
