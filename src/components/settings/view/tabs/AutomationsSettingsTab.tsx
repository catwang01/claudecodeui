import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';

const INTERVAL_OPTIONS = [
  { value: 5 * 60 * 1000, key: '5min' },
  { value: 10 * 60 * 1000, key: '10min' },
  { value: 30 * 60 * 1000, key: '30min' },
  { value: 60 * 60 * 1000, key: '1hour' },
  { value: 2 * 60 * 60 * 1000, key: '2hours' },
  { value: 4 * 60 * 60 * 1000, key: '4hours' },
];

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_PROMPT = 'Based on this conversation, please organize and update the relevant project documentation.';
const DEFAULT_MIN_MESSAGE_COUNT = 20;
const DEFAULT_MODEL = 'claude-opus-4-6';

export default function AutomationsSettingsTab() {
  const { t } = useTranslation('settings');

  const [intervalMs, setIntervalMs] = useState(DEFAULT_INTERVAL_MS);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [minMessageCount, setMinMessageCount] = useState(DEFAULT_MIN_MESSAGE_COUNT);
  const [hideAutoDoc, setHideAutoDoc] = useState(true);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);

  useEffect(() => {
    authenticatedFetch('/api/settings/auto-doc')
      .then(res => res.json())
      .then(data => {
        if (data.intervalMs) setIntervalMs(data.intervalMs);
        if (data.prompt) setPrompt(data.prompt);
        if (data.minMessageCount) setMinMessageCount(data.minMessageCount);
        if (data.model) setModel(data.model);
        setHideAutoDoc(!!data.hideAutoDoc);
      })
      .catch(() => {/* use defaults */})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus(null);
    try {
      const res = await authenticatedFetch('/api/settings/auto-doc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMs, prompt, minMessageCount, hideAutoDoc, model }),
      });
      if (res.ok) {
        setSaveStatus('success');
      } else {
        setSaveStatus('error');
      }
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
          <h3 className="text-lg font-medium text-foreground">{t('autoDoc.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('autoDoc.description')}</p>
      </div>

      <div className="space-y-5 bg-card border border-border rounded-lg p-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground" htmlFor="auto-doc-interval">
            {t('autoDoc.intervalLabel')}
          </label>
          <p className="text-xs text-muted-foreground">{t('autoDoc.intervalDescription')}</p>
          <select
            id="auto-doc-interval"
            value={intervalMs}
            onChange={e => setIntervalMs(Number(e.target.value))}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {INTERVAL_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {t(`autoDoc.intervalOptions.${opt.key}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground" htmlFor="auto-doc-prompt">
            {t('autoDoc.promptLabel')}
          </label>
          <p className="text-xs text-muted-foreground">{t('autoDoc.promptDescription')}</p>
          <textarea
            id="auto-doc-prompt"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground" htmlFor="auto-doc-min-messages">
            {t('autoDoc.minMessageCountLabel')}
          </label>
          <p className="text-xs text-muted-foreground">{t('autoDoc.minMessageCountDescription')}</p>
          <input
            id="auto-doc-min-messages"
            type="number"
            min={1}
            max={10000}
            value={minMessageCount}
            onChange={e => setMinMessageCount(Number(e.target.value))}
            className="w-32 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground" htmlFor="auto-doc-model">
            {t('autoDoc.modelLabel')}
          </label>
          <p className="text-xs text-muted-foreground">{t('autoDoc.modelDescription')}</p>
          <input
            id="auto-doc-model"
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-72 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1 flex-1">
            <label className="text-sm font-medium text-foreground" htmlFor="auto-doc-hide">
              {t('autoDoc.hideAutoDocLabel')}
            </label>
            <p className="text-xs text-muted-foreground">{t('autoDoc.hideAutoDocDescription')}</p>
          </div>
          <button
            id="auto-doc-hide"
            type="button"
            role="switch"
            aria-checked={hideAutoDoc}
            onClick={() => setHideAutoDoc(prev => !prev)}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
              hideAutoDoc ? 'bg-primary' : 'bg-input'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${
                hideAutoDoc ? 'translate-x-4' : 'translate-x-0'
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
            {saving ? t('autoDoc.saving') : t('actions.saveChanges')}
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
