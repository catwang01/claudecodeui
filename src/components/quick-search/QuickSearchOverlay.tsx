import { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { FolderOpen, MessageSquare, Search, X } from 'lucide-react';
import { api } from '../../utils/api';
import { readProjectExcludePatterns } from '../sidebar/utils/utils';
import type { Project, ProjectSession, SessionProvider } from '../../types/app';
import { containsAllWords, newestMatch, sortByTimestampDescending } from './quickSearchResults';

type Highlight = { start: number; end: number };

type ResultItem =
  | { kind: 'project'; project: Project; highlights?: Highlight[]; matchScore?: number }
  | {
      kind: 'conversation';
      sessionId: string;
      sessionSummary: string;
      projectName: string;
      projectDisplayName: string;
      snippet: string;
      highlights?: Highlight[];
      timestamp?: string | null;
      provider?: string;
    };

type ConversationResult = Extract<ResultItem, { kind: 'conversation' }>;

type Props = {
  projects: Project[];
  onSessionSelect: (session: ProjectSession) => void;
  onProjectSelect: (project: Project) => void;
  onClose: () => void;
};

type FlatSession = {
  session: ProjectSession;
  projectName: string;
  projectDisplayName: string;
};

function fuzzyMatch(
  query: string,
  target: string,
): { matched: boolean; score: number; highlights: Highlight[] } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return { matched: true, score: 0, highlights: [] };

  const highlights: Highlight[] = [];
  let qi = 0;
  let score = 0;
  let consecutiveCount = 0;
  let lastMatchIdx = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (lastMatchIdx === ti - 1) {
        consecutiveCount++;
        score += consecutiveCount * 2;
      } else {
        consecutiveCount = 1;
        if (ti === 0 || /[\s\-_/\\.@]/.test(t[ti - 1])) {
          score += 5; // word boundary bonus
        }
      }
      score += 1;
      highlights.push({ start: ti, end: ti + 1 });
      lastMatchIdx = ti;
      qi++;
    }
  }

  const merged: Highlight[] = [];
  for (const h of highlights) {
    if (merged.length && merged[merged.length - 1].end === h.start) {
      merged[merged.length - 1].end = h.end;
    } else {
      merged.push({ ...h });
    }
  }

  return { matched: qi === q.length, score, highlights: merged };
}

function getAllSessions(projects: Project[]): FlatSession[] {
  const sessions: FlatSession[] = [];
  for (const project of projects) {
    const displayName = project.displayName ?? project.name;
    const push = (s: ProjectSession, provider: SessionProvider) =>
      sessions.push({
        session: { ...s, __provider: provider, __projectName: project.name },
        projectName: project.name,
        projectDisplayName: displayName,
      });
    for (const s of project.sessions ?? []) push(s, 'claude');
    for (const s of project.cursorSessions ?? []) push(s, 'cursor');
    for (const s of project.codexSessions ?? []) push(s, 'codex');
    for (const s of project.geminiSessions ?? []) push(s, 'gemini');
    for (const s of project.copilotSessions ?? []) push(s, 'copilot');
  }
  return sessions;
}

function getResultKey(result: ResultItem): string {
  if (result.kind === 'project') return `project-${result.project.name}`;
  return `conv-${result.sessionId}`;
}

function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return '';
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getResultLabel(result: ResultItem): { primary: string; secondary: string } {
  if (result.kind === 'project') {
    return {
      primary: result.project.displayName ?? result.project.name,
      secondary: result.project.fullPath ?? '',
    };
  }
  const time = formatTimestamp(result.timestamp);
  return {
    primary: result.snippet || result.sessionId.slice(0, 8),
    secondary: time ? `${result.projectDisplayName} · ${time}` : result.projectDisplayName,
  };
}

function HighlightedText({ text, highlights }: { text: string; highlights?: Highlight[] }) {
  if (!highlights?.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const { start, end } of highlights) {
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <mark key={start} className="bg-primary/25 text-foreground rounded-sm not-italic">
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}

function ResultIcon({ kind }: { kind: ResultItem['kind'] }) {
  if (kind === 'project') {
    return (
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
        <FolderOpen className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-sky-500/15 text-sky-600 dark:text-sky-400">
      <MessageSquare className="h-4 w-4" />
    </span>
  );
}

export default function QuickSearchOverlay({ projects, onSessionSelect, onProjectSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ResultItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchError, setSearchError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const searchSeqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    searchSeqRef.current += 1;
    const seq = searchSeqRef.current;
    const trimmed = query.trim();
    setSearchError(false);

    if (!trimmed) {
      setResults([]);
      setSelectedIndex(0);
      setSearchError(false);
      return;
    }

    const words = trimmed.split(/\s+/).filter(Boolean);
    const fuzzyMatchWords = (target: string) => {
      let totalScore = 0;
      const allHighlights: Highlight[] = [];
      for (const word of words) {
        const result = fuzzyMatch(word, target);
        if (result.matched) {
          totalScore += result.score;
          allHighlights.push(...result.highlights);
        }
      }
      return totalScore > 0 ? { score: totalScore, highlights: allHighlights } : null;
    };

    const projectMatches: ResultItem[] = projectsRef.current
      .flatMap((p) => {
        const primaryText = p.displayName ?? p.name;
        const primaryResult = fuzzyMatchWords(primaryText);
        const pathMatches = p.fullPath ? containsAllWords(p.fullPath, words) : false;
        const bestScore = Math.max(primaryResult?.score ?? 0, pathMatches ? 1 : 0);
        if (bestScore === 0) return [];
        return [{ kind: 'project' as const, project: p, highlights: primaryResult?.highlights ?? [], matchScore: bestScore }];
      })
      .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
      .slice(0, 5);

    setResults(projectMatches);
    setSelectedIndex(0);

    if (trimmed.length >= 2) {
      debounceRef.current = setTimeout(() => {
        if (seq !== searchSeqRef.current) return;

        const url = api.searchConversationsUrl(trimmed, 20, readProjectExcludePatterns());
        const es = new EventSource(url);
        eventSourceRef.current = es;

        const convResults: ConversationResult[] = [];
        const seenIds = new Set<string>();

        es.addEventListener('result', (evt: MessageEvent) => {
          if (seq !== searchSeqRef.current) {
            es.close();
            return;
          }
          try {
            const data = JSON.parse(evt.data as string) as {
              projectResult: {
                projectName: string;
                projectDisplayName: string;
                sessions: {
                  sessionId: string;
                  sessionSummary: string;
                  provider?: string;
                  matches: { snippet: string; highlights?: Highlight[]; timestamp?: string | null }[];
                }[];
              };
            };
            const isExcluded = !projectsRef.current.some(
              (p) => p.name === data.projectResult.projectName,
            );
            if (isExcluded) return;
            for (const s of data.projectResult.sessions) {
              if (!seenIds.has(s.sessionId)) {
                const match = newestMatch(s.matches);
                seenIds.add(s.sessionId);
                convResults.push({
                  kind: 'conversation',
                  sessionId: s.sessionId,
                  sessionSummary: s.sessionSummary,
                  projectName: data.projectResult.projectName,
                  projectDisplayName: data.projectResult.projectDisplayName,
                  snippet: match?.snippet ?? '',
                  highlights: match?.highlights,
                  timestamp: match?.timestamp,
                  provider: s.provider,
                });
              }
            }
            setResults((prev) => {
              const nonConv = prev.filter((r) => r.kind !== 'conversation');
              return [...nonConv, ...sortByTimestampDescending(convResults).slice(0, 20)];
            });
          } catch {
            // ignore malformed SSE
          }
        });

        es.addEventListener('done', () => {
          es.close();
          eventSourceRef.current = null;
        });

        es.addEventListener('error', () => {
          es.close();
          eventSourceRef.current = null;
          if (seq === searchSeqRef.current) {
            setSearchError(true);
          }
        });
      }, 200);
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [query]);

  const selectResult = useCallback(
    (result: ResultItem) => {
      if (result.kind === 'project') {
        onProjectSelect(result.project);
      } else {
        const searchTarget = {
          __searchTargetTimestamp: result.timestamp ?? null,
          __searchTargetSnippet: result.snippet || null,
        };
        const found = getAllSessions(projects).find(({ session }) => session.id === result.sessionId);
        if (found) {
          onSessionSelect({ ...found.session, ...searchTarget });
        } else {
          const minSession: ProjectSession = {
            id: result.sessionId,
            title: result.sessionSummary,
            __provider: (result.provider ?? 'claude') as SessionProvider,
            __projectName: result.projectName,
            ...searchTarget,
          };
          onSessionSelect(minSession);
        }
      }
      onClose();
    },
    [onProjectSelect, onSessionSelect, onClose, projects],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && results[selectedIndex]) {
        selectResult(results[selectedIndex]);
      }
    },
    [onClose, results, selectedIndex, selectResult],
  );

  const portal = ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center px-4"
      style={{ paddingTop: '15vh' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Quick search"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
      <div
        className="relative w-full max-w-2xl bg-card border border-border/50 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
          <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search projects and chat history..."
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {results.length > 0 ? (
          <ul className="max-h-80 overflow-y-auto py-1">
            {results.map((result, index) => {
              const { primary, secondary } = getResultLabel(result);
              const highlights = result.kind === 'conversation' && result.snippet
                ? result.highlights
                : result.kind === 'project'
                  ? result.highlights
                  : undefined;
              return (
                <li
                  key={getResultKey(result)}
                  className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer text-sm transition-colors ${
                    index === selectedIndex
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground hover:bg-accent/50'
                  }`}
                  onClick={() => selectResult(result)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <ResultIcon kind={result.kind} />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate font-medium">
                      <HighlightedText text={primary} highlights={highlights} />
                    </span>
                    {secondary && (
                      <span className="truncate text-xs text-muted-foreground">{secondary}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : searchError ? (
          <div className="px-4 py-6 text-center text-sm text-destructive">Search failed. Try again.</div>
        ) : query.trim() ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">No results</div>
        ) : (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">Type to search</div>
        )}
      </div>
    </div>,
    document.body,
  );

  return portal;
}
