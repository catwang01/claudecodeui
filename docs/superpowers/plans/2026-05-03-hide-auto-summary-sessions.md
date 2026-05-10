# Hide Auto-Summary Sessions Implementation Plan

> **Status:** Completed. All tasks implemented. Terminology later renamed `autoSummary` → `autoDoc` across the codebase.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggle in Auto Doc Generation settings to hide auto-generated sessions from all sidebar views (Recents list and per-project session list).

**Architecture:** Store `hideAutoSummary` boolean in the existing `app_config` table alongside `auto_summary_interval_ms` and `auto_summary_prompt`. The frontend fetches this setting with the other auto-summary config and uses it as a runtime filter — sessions with `isAutoSummary === true` are excluded from rendering when the toggle is enabled. Toggling it off instantly restores visibility (no persistent per-session state).

**Tech Stack:** Express.js (backend), React + TypeScript (frontend), react-i18next (i18n), SQLite via `appConfigDb` (persistence)

---

### Task 1: Extend the backend API to include `hideAutoSummary`

**Files:**
- Modify: `server/routes/settings.js:283-320`

- [x] **Step 1: Update GET `/api/settings/auto-summary` to return `hideAutoSummary`**

In `server/routes/settings.js`, change the GET handler (around line 283):

```js
router.get('/auto-summary', async (req, res) => {
  try {
    const intervalMs = parseInt(appConfigDb.get('auto_summary_interval_ms'), 10) || AUTO_SUMMARY_DEFAULT_INTERVAL_MS;
    const prompt = appConfigDb.get('auto_summary_prompt') || AUTO_SUMMARY_DEFAULT_PROMPT;
    const hideAutoSummary = appConfigDb.get('auto_summary_hide_sessions') === 'true';
    res.json({ intervalMs, prompt, hideAutoSummary });
  } catch (error) {
    console.error('Error fetching auto-summary config:', error);
    res.status(500).json({ error: 'Failed to fetch auto-summary config' });
  }
});
```

- [x] **Step 2: Update PUT `/api/settings/auto-summary` to accept and persist `hideAutoSummary`**

In `server/routes/settings.js`, change the PUT handler (around line 294):

```js
router.put('/auto-summary', async (req, res) => {
  try {
    const { intervalMs, prompt, hideAutoSummary } = req.body;

    if (intervalMs != null) {
      const ms = parseInt(intervalMs, 10);
      if (isNaN(ms) || ms < 60000) {
        return res.status(400).json({ error: 'intervalMs must be at least 60000 (1 minute)' });
      }
      appConfigDb.set('auto_summary_interval_ms', String(ms));
    }

    if (prompt != null) {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'prompt must be a non-empty string' });
      }
      appConfigDb.set('auto_summary_prompt', prompt.trim());
    }

    if (hideAutoSummary != null) {
      appConfigDb.set('auto_summary_hide_sessions', hideAutoSummary ? 'true' : 'false');
    }

    const savedIntervalMs = parseInt(appConfigDb.get('auto_summary_interval_ms'), 10) || AUTO_SUMMARY_DEFAULT_INTERVAL_MS;
    const savedPrompt = appConfigDb.get('auto_summary_prompt') || AUTO_SUMMARY_DEFAULT_PROMPT;
    const savedHideAutoSummary = appConfigDb.get('auto_summary_hide_sessions') === 'true';
    res.json({ success: true, intervalMs: savedIntervalMs, prompt: savedPrompt, hideAutoSummary: savedHideAutoSummary });
  } catch (error) {
    console.error('Error saving auto-summary config:', error);
    res.status(500).json({ error: 'Failed to save auto-summary config' });
  }
});
```

- [x] **Step 3: Commit**

```bash
git add server/routes/settings.js
git commit -m "feat(settings): add hideAutoSummary to auto-summary config API"
```

---

### Task 2: Add i18n translations

**Files:**
- Modify: `src/i18n/locales/en/settings.json`
- Modify: `src/i18n/locales/zh-CN/settings.json`
- Modify: `src/i18n/locales/ja/settings.json`
- Modify: `src/i18n/locales/ko/settings.json`
- Modify: `src/i18n/locales/de/settings.json`
- Modify: `src/i18n/locales/ru/settings.json`

- [x] **Step 1: Add English keys to `src/i18n/locales/en/settings.json`**

In the `"autoDoc"` section (around line 213), add two keys:

```json
"autoDoc": {
  "title": "Auto Doc Generation",
  "description": "Configure background automation tasks that run periodically on your Claude sessions.",
  "intervalLabel": "Run interval",
  "intervalDescription": "How often to process recent sessions.",
  "promptLabel": "Agent prompt",
  "promptDescription": "The prompt sent to each session when it is processed.",
  "saving": "Saving...",
  "hideAutoSummaryLabel": "Hide auto-generated sessions",
  "hideAutoSummaryDescription": "Auto-generated sessions will not appear in the sidebar."
}
```

- [x] **Step 2: Add Chinese (zh-CN) keys to `src/i18n/locales/zh-CN/settings.json`**

Find the `"autoDoc"` section and add:

```json
"hideAutoSummaryLabel": "隐藏自动生成的 Session",
"hideAutoSummaryDescription": "自动生成的 Session 将不会出现在侧边栏中。"
```

- [x] **Step 3: Add Japanese (ja) keys to `src/i18n/locales/ja/settings.json`**

```json
"hideAutoSummaryLabel": "自動生成セッションを非表示",
"hideAutoSummaryDescription": "自動生成されたセッションはサイドバーに表示されません。"
```

- [x] **Step 4: Add Korean (ko) keys to `src/i18n/locales/ko/settings.json`**

```json
"hideAutoSummaryLabel": "자동 생성된 세션 숨기기",
"hideAutoSummaryDescription": "자동 생성된 세션은 사이드바에 표시되지 않습니다."
```

- [x] **Step 5: Add German (de) keys to `src/i18n/locales/de/settings.json`**

```json
"hideAutoSummaryLabel": "Automatisch generierte Sitzungen ausblenden",
"hideAutoSummaryDescription": "Automatisch generierte Sitzungen werden nicht in der Seitenleiste angezeigt."
```

- [x] **Step 6: Add Russian (ru) keys to `src/i18n/locales/ru/settings.json`**

```json
"hideAutoSummaryLabel": "Скрыть автоматически созданные сессии",
"hideAutoSummaryDescription": "Автоматически созданные сессии не будут отображаться на боковой панели."
```

- [x] **Step 7: Commit**

```bash
git add src/i18n/locales/
git commit -m "feat(i18n): add hideAutoSummary translation keys for all locales"
```

---

### Task 3: Add toggle UI to AutomationsSettingsTab

**Files:**
- Modify: `src/components/settings/view/tabs/AutomationsSettingsTab.tsx`

- [x] **Step 1: Add `hideAutoSummary` state and load it from API**

Replace the existing state declarations and useEffect in `AutomationsSettingsTab.tsx`:

```tsx
const [intervalMs, setIntervalMs] = useState(DEFAULT_INTERVAL_MS);
const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
const [hideAutoSummary, setHideAutoSummary] = useState(false);
const [loading, setLoading] = useState(true);
const [saving, setSaving] = useState(false);
const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);

useEffect(() => {
  authenticatedFetch('/api/settings/auto-summary')
    .then(res => res.json())
    .then(data => {
      if (data.intervalMs) setIntervalMs(data.intervalMs);
      if (data.prompt) setPrompt(data.prompt);
      setHideAutoSummary(!!data.hideAutoSummary);
    })
    .catch(() => {/* use defaults */})
    .finally(() => setLoading(false));
}, []);
```

- [x] **Step 2: Include `hideAutoSummary` in the save payload**

Replace the `handleSave` function body:

```tsx
const handleSave = async () => {
  setSaving(true);
  setSaveStatus(null);
  try {
    const res = await authenticatedFetch('/api/settings/auto-summary', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMs, prompt, hideAutoSummary }),
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
```

- [x] **Step 3: Add the toggle UI inside the settings card**

After the existing `<div className="space-y-2">` block for the prompt textarea (before the save button div), add:

```tsx
<div className="flex items-center justify-between gap-4">
  <div className="space-y-1 flex-1">
    <label className="text-sm font-medium text-foreground" htmlFor="auto-summary-hide">
      {t('autoDoc.hideAutoSummaryLabel')}
    </label>
    <p className="text-xs text-muted-foreground">{t('autoDoc.hideAutoSummaryDescription')}</p>
  </div>
  <button
    id="auto-summary-hide"
    type="button"
    role="switch"
    aria-checked={hideAutoSummary}
    onClick={() => setHideAutoSummary(prev => !prev)}
    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
      hideAutoSummary ? 'bg-primary' : 'bg-input'
    }`}
  >
    <span
      className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${
        hideAutoSummary ? 'translate-x-4' : 'translate-x-0'
      }`}
    />
  </button>
</div>
```

- [x] **Step 4: Commit**

```bash
git add src/components/settings/view/tabs/AutomationsSettingsTab.tsx
git commit -m "feat(settings): add hide auto-summary sessions toggle in Auto Doc Generation tab"
```

---

### Task 4: Apply the filter in the sidebar

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`

- [x] **Step 1: Fetch `hideAutoSummary` setting in SidebarContent**

After the existing `const [hiddenSet, setHiddenSet] = useState<Set<string>>(new Set());` line (around line 104), add:

```tsx
const [hideAutoSummary, setHideAutoSummary] = useState(false);

useEffect(() => {
  authenticatedFetch('/api/settings/auto-summary')
    .then(res => res.json())
    .then(data => setHideAutoSummary(!!data.hideAutoSummary))
    .catch(() => {/* keep default false */});
}, []);
```

- [x] **Step 2: Filter auto-summary sessions from `recentSessions`**

In the `.filter()` call inside the `recentSessions` useMemo (around line 128), add the check:

```tsx
.filter(({ session }) => {
  if (hideAutoSummary && session.isAutoSummary) return false;
  if (session.hiddenFromRecents) return false;
  const provider = session.__provider || 'claude';
  if (hiddenSet.has(`${session.id}:${provider}`)) return false;
  return true;
})
```

Also add `hideAutoSummary` to the useMemo dependency array:

```tsx
}, [searchMode, projectListProps, hiddenSet, hideAutoSummary]);
```

- [x] **Step 3: Filter auto-summary sessions from the project view**

The project view (`SidebarProjectList`) uses `projectListProps.getProjectSessions`. Wrap it by passing a modified `projectListProps` to `SidebarProjectList` that filters auto-summary sessions:

```tsx
const filteredProjectListProps = useMemo(() => {
  if (!hideAutoSummary) return projectListProps;
  return {
    ...projectListProps,
    getProjectSessions: (project: Parameters<typeof projectListProps.getProjectSessions>[0]) =>
      projectListProps.getProjectSessions(project).filter(s => !s.isAutoSummary),
  };
}, [projectListProps, hideAutoSummary]);
```

Then replace `<SidebarProjectList {...projectListProps} />` with:

```tsx
<SidebarProjectList {...filteredProjectListProps} />
```

- [x] **Step 4: Commit**

```bash
git add src/components/sidebar/view/subcomponents/SidebarContent.tsx
git commit -m "feat(sidebar): hide auto-summary sessions from all sidebar views when setting enabled"
```
