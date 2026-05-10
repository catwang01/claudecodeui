import { useEffect, useState } from 'react';
import { Radio, ExternalLink, Square } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';

interface TapSession {
  sessionId: string;
  sessionTitle: string;
  proxyPort: number;
  viewerPort: number;
  startedAt: string;
}

function timeAgo(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function getAuthToken(): string | null {
  return localStorage.getItem('auth-token');
}

export default function TapPage() {
  const [sessions, setSessions] = useState<TapSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchSessions = async () => {
      try {
        const res = await authenticatedFetch('/api/settings/tap/sessions');
        if (!cancelled) {
          if (!res.ok) {
            setError('Failed to load tap sessions');
          } else {
            const data = await res.json();
            setSessions(data);
            setError(null);
          }
        }
      } catch {
        if (!cancelled) setError('Failed to load tap sessions');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleStop = async (sessionId: string) => {
    setError(null);
    setStoppingIds(prev => new Set(prev).add(sessionId));
    try {
      const res = await authenticatedFetch(`/api/settings/tap/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSessions(prev => prev.filter(s => s.sessionId !== sessionId));
      } else {
        setError('Failed to stop tap session');
      }
    } catch {
      setError('Failed to stop tap session');
    } finally {
      setStoppingIds(prev => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleView = (sessionId: string) => {
    const token = getAuthToken();
    const url = token
      ? `/api/tap/sessions/${sessionId}/viewer?token=${encodeURIComponent(token)}`
      : `/api/tap/sessions/${sessionId}/viewer`;
    window.open(url, '_blank', 'noreferrer');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-24">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Radio className="w-5 h-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold text-foreground">API Traffic Inspector</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Active claude-tap sessions. Click View to inspect traffic.
        </p>
      </div>

      {/* Error banner (only when sessions are present, so stop errors are visible) */}
      {error && sessions.length > 0 && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Table */}
      {error && sessions.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-sm text-destructive">
          {error}
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          No active tap sessions.
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Session</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Started</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sessions.map(session => (
                <tr key={session.sessionId} className="bg-card hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 text-foreground font-medium truncate max-w-xs">
                    {session.sessionTitle || session.sessionId}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                    {timeAgo(session.startedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400 text-xs font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                      Running
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleView(session.sessionId)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => handleStop(session.sessionId)}
                        disabled={stoppingIds.has(session.sessionId)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium border border-border text-muted-foreground hover:text-destructive hover:border-destructive transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Square className="w-3 h-3" />
                        {stoppingIds.has(session.sessionId) ? 'Stopping…' : 'Stop'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
