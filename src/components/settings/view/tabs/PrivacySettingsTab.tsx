import { useEffect, useState, useCallback } from 'react';
import { Shield, RefreshCw, Trash2, ChevronRight, ChevronDown } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';

type LogEntry = {
  id: string;
  ts: string;
  label: string;
  diff: string;
};

type RequestGroup = {
  id: string;
  ts: string;
  entries: LogEntry[];
};

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto rounded bg-muted/50 p-3 text-xs font-mono leading-5">
      {diff.split('\n').map((line, i) => {
        let cls = 'text-muted-foreground';
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-muted-foreground';
        else if (line.startsWith('+')) cls = 'bg-green-500/15 text-green-700 dark:text-green-400';
        else if (line.startsWith('-')) cls = 'bg-red-500/15 text-red-700 dark:text-red-400';
        else if (line.startsWith('@@')) cls = 'text-blue-500 dark:text-blue-400';
        return (
          <div key={i} className={`block px-1 ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function RequestItem({ group }: { group: RequestGroup }) {
  const [expanded, setExpanded] = useState(false);
  const [openLabel, setOpenLabel] = useState<string | null>(null);

  const time = new Date(group.ts).toLocaleTimeString();

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-accent/30 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          )}
          <span className="font-mono text-xs text-muted-foreground">[{group.id}]</span>
          <span className="text-xs text-foreground">
            {group.entries.length} 处替换
          </span>
        </div>
        <span className="flex-shrink-0 text-xs text-muted-foreground">{time}</span>
      </button>

      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {group.entries.map((entry, i) => (
            <div key={i} className="px-3 py-2">
              <button
                type="button"
                onClick={() => setOpenLabel(openLabel === entry.label ? null : entry.label)}
                className="flex w-full items-center gap-2 text-left"
              >
                {openLabel === entry.label ? (
                  <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                )}
                <span className="font-mono text-xs text-foreground">{entry.label}</span>
              </button>
              {openLabel === entry.label && (
                <div className="mt-2">
                  <DiffView diff={entry.diff} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PrivacySettingsTab() {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [logs, setLogs] = useState<RequestGroup[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    authenticatedFetch('/api/settings/pii-proxy')
      .then(res => res.json())
      .then(data => setEnabled(data.enabled ?? true))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await authenticatedFetch('/api/settings/pii-proxy/logs');
      const data = await res.json();
      const entries: LogEntry[] = data.entries ?? [];
      const map = new Map<string, RequestGroup>();
      for (const e of entries) {
        if (!map.has(e.id)) map.set(e.id, { id: e.id, ts: e.ts, entries: [] });
        map.get(e.id)!.entries.push(e);
      }
      setLogs(Array.from(map.values()).reverse());
    } catch {
      // proxy not running
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const handleToggle = async () => {
    const newValue = !enabled;
    setEnabled(newValue);
    setSaving(true);
    try {
      await authenticatedFetch('/api/settings/pii-proxy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newValue }),
      });
    } catch {
      setEnabled(!newValue);
    } finally {
      setSaving(false);
    }
  };

  const handleClearLogs = async () => {
    await authenticatedFetch('/api/settings/pii-proxy/logs', { method: 'DELETE' });
    setLogs([]);
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
          <Shield className="w-5 h-5 text-green-600" />
          <h3 className="text-lg font-medium text-foreground">PII 脱敏代理</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          开启后，发送给 Anthropic API 的消息中将自动检测并加密替换姓名、手机号、邮箱等个人信息，响应返回前自动还原，防止 PII 暴露给大模型。
        </p>
      </div>

      <div className="space-y-4 bg-card border border-border rounded-lg p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1 flex-1">
            <p className="text-sm font-medium text-foreground">启用 PII 脱敏代理</p>
            <p className="text-xs text-muted-foreground">
              默认开启。关闭后请求将直接发送至 Anthropic API，不经过代理处理。
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={saving}
            onClick={handleToggle}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
              enabled ? 'bg-primary' : 'bg-input'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${
                enabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium mb-1">检测实体类型</p>
          <p>姓名 · 电话号码 · 邮箱地址 · 信用卡号 · 地址</p>
        </div>
      </div>

      {/* Log viewer */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-foreground">脱敏日志</h4>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={fetchLogs}
              disabled={logsLoading}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${logsLoading ? 'animate-spin' : ''}`} />
              刷新
            </button>
            {logs.length > 0 && (
              <button
                type="button"
                onClick={handleClearLogs}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                清除
              </button>
            )}
          </div>
        </div>

        {logs.length === 0 ? (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-8 text-center text-xs text-muted-foreground">
            {logsLoading ? '加载中…' : '暂无脱敏记录。发送包含 PII 的消息后将在此显示。'}
          </div>
        ) : (
          <div className="space-y-2">
            {logs.map(group => (
              <RequestItem key={`${group.id}-${group.ts}`} group={group} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
