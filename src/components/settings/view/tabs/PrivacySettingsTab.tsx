import { useEffect, useState, useCallback, useMemo } from 'react';
import { Shield, RefreshCw, Trash2, ChevronRight, ChevronDown, Search } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';

type PiiOccurrence = {
  req_id: string;
  ts: string;
  label: string;
};

type PiiGroup = {
  token_key: string;
  entity_type: string;
  masked: string;
  count: number;
  last_seen: string;
  occurrences: PiiOccurrence[];
};

const ENTITY_COLORS: Record<string, string> = {
  PASSWORD:       'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  PRIVATE_KEY:    'bg-red-500/15 text-red-700 dark:text-red-400',
  JWT_TOKEN:      'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  SECRET_KEYWORD: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  BASIC_AUTH:     'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  AWS_KEY:        'bg-orange-500/15 text-orange-700 dark:text-orange-400',
};

function entityColor(type: string) {
  return ENTITY_COLORS[type] ?? 'bg-slate-500/15 text-slate-600 dark:text-slate-400';
}

function PiiGroupItem({ group }: { group: PiiGroup }) {
  const [expanded, setExpanded] = useState(false);
  const lastSeen = new Date(group.last_seen).toLocaleTimeString();

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
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide flex-shrink-0 ${entityColor(group.entity_type)}`}>
            {group.entity_type}
          </span>
          <span className="font-mono text-xs text-foreground truncate">{group.masked}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="rounded-full bg-primary/10 text-primary text-[10px] font-medium px-2 py-0.5">
            ×{group.count}
          </span>
          <span className="text-xs text-muted-foreground">{lastSeen}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border divide-y divide-border bg-muted/10">
          {group.occurrences.map((occ, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-1.5 gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[10px] text-muted-foreground flex-shrink-0">[{occ.req_id.slice(0, 8)}]</span>
                <span className="text-xs text-foreground truncate">{occ.label}</span>
              </div>
              <span className="text-[10px] text-muted-foreground flex-shrink-0">
                {new Date(occ.ts).toLocaleTimeString()}
              </span>
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
  const [groups, setGroups] = useState<PiiGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    authenticatedFetch('/api/settings/pii-proxy')
      .then(res => res.json())
      .then(data => setEnabled(data.enabled ?? true))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fetchGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const res = await authenticatedFetch('/api/settings/pii-proxy/pii-groups');
      const data = await res.json();
      setGroups(data.groups ?? []);
    } catch {
      // proxy not running
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const filtered = useMemo(() => {
    if (!query.trim()) return groups;
    const q = query.toLowerCase();
    return groups.filter(
      g => g.entity_type.toLowerCase().includes(q) || g.masked.toLowerCase().includes(q)
    );
  }, [groups, query]);

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

  const handleClear = async () => {
    await authenticatedFetch('/api/settings/pii-proxy/logs', { method: 'DELETE' });
    setGroups([]);
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
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-foreground flex-shrink-0">脱敏记录</h4>
          <div className="flex items-center gap-2 flex-1 justify-end">
            {/* Search */}
            <div className="relative flex-1 max-w-48">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索类型或值…"
                className="w-full rounded-md border border-border bg-background pl-6 pr-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <button
              type="button"
              onClick={fetchGroups}
              disabled={groupsLoading}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${groupsLoading ? 'animate-spin' : ''}`} />
              刷新
            </button>
            {groups.length > 0 && (
              <button
                type="button"
                onClick={handleClear}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                清除
              </button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-8 text-center text-xs text-muted-foreground">
            {groupsLoading
              ? '加载中…'
              : query
              ? '无匹配结果'
              : '暂无脱敏记录。发送包含 PII 的消息后将在此显示。'}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(group => (
              <PiiGroupItem key={group.token_key} group={group} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
