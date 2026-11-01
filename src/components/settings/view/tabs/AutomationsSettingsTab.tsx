import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';

export default function AutomationsSettingsTab() {
  const { t } = useTranslation('settings');

  // Server default is "hidden" (app_config.scheduled_task_hide_sessions); keep the same initial
  // value so the first paint does not flash the scheduled-task sessions.
  const [hideScheduledTaskSessions, setHideScheduledTaskSessions] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);

  useEffect(() => {
    authenticatedFetch('/api/settings/automations')
      .then(res => res.json())
      .then(data => {
        if (typeof data?.hideScheduledTaskSessions === 'boolean') {
          setHideScheduledTaskSessions(data.hideScheduledTaskSessions);
        }
      })
      .catch(() => {
        /* keep the server-matching default (hidden) */
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus(null);
    try {
      const res = await authenticatedFetch('/api/settings/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hideScheduledTaskSessions }),
      });
      setSaveStatus(res.ok ? 'success' : 'error');
    } catch {
      setSaveStatus('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveStatus(null), 3000);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Timer className="w-5 h-5 text-blue-600" />
          <h3 className="text-lg font-medium text-foreground">{t('automations.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('automations.description')}</p>
      </div>

      <div className="space-y-5 bg-card border border-border rounded-lg p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1 flex-1">
            <label className="text-sm font-medium text-foreground" htmlFor="scheduled-task-hide">
              {t('automations.hideScheduledTaskSessionsLabel')}
            </label>
            <p className="text-xs text-muted-foreground">{t('automations.hideScheduledTaskSessionsDescription')}</p>
          </div>
          <button
            id="scheduled-task-hide"
            type="button"
            role="switch"
            aria-checked={hideScheduledTaskSessions}
            onClick={() => setHideScheduledTaskSessions(prev => !prev)}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
              hideScheduledTaskSessions ? 'bg-primary' : 'bg-input'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${
                hideScheduledTaskSessions ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? t('automations.saving') : t('actions.saveChanges')}
          </button>
          {saveStatus === 'success' && (
            <span className="text-xs text-green-600 dark:text-green-400 animate-in fade-in">
              {t('saveStatus.success')}
            </span>
          )}
          {saveStatus === 'error' && (
            <span className="text-xs text-red-600 dark:text-red-400 animate-in fade-in">
              {t('saveStatus.error')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
