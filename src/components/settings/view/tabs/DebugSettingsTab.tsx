import { useEffect, useState } from 'react';
import { Bug, Radio } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';

export default function DebugSettingsTab() {
  const [tapEnabled, setTapEnabled] = useState(false);
  const [tapPort, setTapPort] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authenticatedFetch('/api/settings/tap')
      .then(res => res.json())
      .then(data => {
        setTapEnabled(!!data.enabled);
        setTapPort(data.port ?? null);
      })
      .catch(() => {/* use defaults */})
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = async () => {
    setToggling(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/settings/tap', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !tapEnabled }),
      });
      const data = await res.json();
      if (res.ok) {
        setTapEnabled(!!data.enabled);
        setTapPort(data.port ?? null);
      } else {
        setError(data.error ?? 'Failed to toggle');
      }
    } catch {
      setError('Request failed');
    } finally {
      setToggling(false);
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
      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bug className="w-5 h-5 text-orange-500" />
          <h3 className="text-lg font-medium text-foreground">Debug Tools</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Developer tools for inspecting internal behavior.
        </p>
      </div>

      {/* Claude-tap section */}
      <div className="space-y-4 bg-card border border-border rounded-lg p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm font-medium text-foreground">API Traffic Inspector</span>
              {tapEnabled && tapPort && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  :{tapPort}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Intercept and record all Claude API traffic via{' '}
              <a
                href="https://github.com/liaohch3/claude-tap"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground transition-colors"
              >
                claude-tap
              </a>
              . Traces are saved to <code className="text-xs bg-muted px-1 rounded">.traces/</code>.
              Requires <code className="text-xs bg-muted px-1 rounded">pip install claude-tap</code>.
            </p>
            {tapEnabled && tapPort && (
              <p className="text-xs text-muted-foreground mt-1">
                Proxy listening on{' '}
                <code className="text-xs bg-muted px-1 rounded">http://127.0.0.1:{tapPort}</code>
              </p>
            )}
            {error && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-1">{error}</p>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={tapEnabled}
            disabled={toggling}
            onClick={handleToggle}
            className={`relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
              tapEnabled ? 'bg-primary' : 'bg-input'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${
                tapEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
