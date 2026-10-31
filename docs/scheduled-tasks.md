# Scheduled Tasks (定时任务) — Design & Frozen Contract

Status: implemented in this change. Reference: DSH `@deepseek-ai/dsh-schedule` /
`dsh-tool-schedule` / `dsh-client-ui-schedule` (persistent reminder service with
`once / interval / daily / weekly / cron` selectors, CRUD, delivery history).

claudecodeui difference: a task's *action* is **starting a new agent run in a project**,
not delivering a message into an existing session.

## 1. Behaviour

A scheduled task = `{ title, prompt, projectPath, provider, model?, rule, enabled }`.

When due, the server starts a **new** headless agent session in `projectPath`, sends
`prompt`, records a run row, then advances `nextRunAt` (or disables a one-shot task).
Runs are also triggerable manually (`POST /:id/run`).

Rule kinds (mirrors DSH selectors):

| kind | payload | notes |
|---|---|---|
| `once` | `{ at: ISO-8601 with offset }` | must be strictly in the future at create/update time |
| `interval` | `{ everySeconds: int >= 60 }` | anchored at creation/save time |
| `daily` | `{ time: 'HH:mm[:ss]', timeZone: IANA }` | local wall clock |
| `weekly` | `{ time, timeZone, weekdays: [1..7] }` | ISO weekdays, Mon=1; unique ascending |
| `cron` | `{ expression: '5 fields', timeZone: IANA }` | Vixie subset: `*`, value, `a-b`, `*/n`, `a-b/n`, comma lists |

DST rules: a missing local wall time is skipped; an ambiguous (repeated) local time uses
the **earlier** instant. Every rule has a finite `nextRunAt` or `null` when exhausted.

## 2. Files and ownership (disjoint write scopes)

| Owner | Files |
|---|---|
| backend-db | `server/scheduled-tasks/rules.js`, `server/scheduled-tasks/rules.test.js`, `server/modules/database/repositories/scheduled-tasks.db.ts`, `server/modules/database/repositories/scheduled-tasks.db.test.ts`, `server/modules/database/schema.ts`, `server/modules/database/migrations.ts`, `server/modules/database/index.ts` |
| backend-runtime | `server/scheduled-tasks/runner.js`, `server/scheduled-tasks/service.js`, `server/scheduled-tasks/runner.test.js`, `server/scheduled-tasks/service.test.js`, `server/routes/scheduled-tasks.js`, `server/routes/scheduled-tasks.test.js`, `server/index.js` |
| frontend | `src/components/scheduled-tasks/**`, `src/components/sidebar/view/subcomponents/SidebarFooter.tsx`, `src/i18n/config.js`, `src/i18n/locales/en/scheduledTasks.json`, `src/i18n/locales/zh-CN/scheduledTasks.json` |
| lead | `docs/scheduled-tasks.md`, `scripts/verify-scheduled-tasks.mjs` |

## 3. Database

`scheduled_tasks` (row columns, snake_case):
`id TEXT PK` (crypto.randomUUID), `user_id INTEGER`, `title TEXT NOT NULL`,
`prompt TEXT NOT NULL`, `project_path TEXT NOT NULL`, `provider TEXT NOT NULL DEFAULT 'claude'`,
`model TEXT`, `kind TEXT NOT NULL`, `rule_json TEXT NOT NULL`, `next_run_at TEXT`,
`last_run_at TEXT`, `last_status TEXT`, `last_error TEXT`, `enabled INTEGER NOT NULL DEFAULT 1`,
`run_count INTEGER NOT NULL DEFAULT 0`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`.

`scheduled_task_runs`:
`id TEXT PK`, `task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE`,
`status TEXT NOT NULL` ('running'|'success'|'error'), `trigger TEXT NOT NULL` ('schedule'|'manual'),
`scheduled_for TEXT`, `started_at TEXT NOT NULL`, `finished_at TEXT`, `session_id TEXT`,
`output TEXT`, `error TEXT`.

Indexes: `(enabled, next_run_at)` on tasks, `(task_id, started_at DESC)` on runs.
Timestamps are ISO-8601 UTC strings.

## 4. Frozen module contracts

### `server/scheduled-tasks/rules.js` (pure, no I/O)
```js
export const RULE_KINDS = ['once', 'interval', 'daily', 'weekly', 'cron'];
export function isValidTimeZone(tz): boolean
export function normalizeRule(rule): NormalizedRule            // throws Error with .code
export function validateRule(input): { ok: true, rule } | { ok: false, code, message }
export function computeNextRun(rule, fromMs = Date.now()): number | null  // epoch ms UTC
export function describeRule(rule): string                    // human readable, English
```
Error codes: `invalid_rule`, `invalid_time_zone`, `invalid_schedule_time`, `invalid_interval`,
`invalid_weekdays`, `invalid_cron`. `validateRule` never throws.

### `server/modules/database/repositories/scheduled-tasks.db.ts`
Exports `scheduledTasksDb` with:
```ts
createTask(input: { id?, userId?, title, prompt, projectPath, provider?, model?, kind, ruleJson, nextRunAt, enabled? }): ScheduledTaskRow
getTask(id): ScheduledTaskRow | undefined
listTasks(opts?: { userId?: number|null, status?: 'active'|'paused'|'all', search?: string }): ScheduledTaskRow[]
updateTask(id, patch: Partial<{title, prompt, projectPath, provider, model, kind, ruleJson, nextRunAt, enabled}>): ScheduledTaskRow | undefined
deleteTask(id): boolean
listDueTasks(nowIso: string, limit = 50): ScheduledTaskRow[]
advanceTask(id, { nextRunAt, lastRunAt, lastStatus, lastError, runCount }): ScheduledTaskRow | undefined
createRun(input: { taskId, status, trigger, scheduledFor?, startedAt }): ScheduledTaskRunRow
finishRun(id, patch: { status, finishedAt, sessionId?, output?, error? }): ScheduledTaskRunRow | undefined
listRuns(taskId, limit = 20, offset = 0): ScheduledTaskRunRow[]
countRuns(taskId): number
pruneRuns(taskId, keep = 50): number
```
Update/advance must bump `updated_at`. `listTasks` search matches title/prompt/project_path, ordered by `created_at DESC`.

### `server/scheduled-tasks/runner.js`
```js
export function startTaskRun(task, { trigger = 'schedule', scheduledFor = null } = {}):
  { run: ScheduledTaskRunRow, done: Promise<{ run, status, sessionId, output, error }> }
```
Creates the 'running' run row synchronously, then executes on the microtask queue; never
rejects (failures come back as `status: 'error'`). MVP executes `provider === 'claude'`
via `queryClaudeSDK` with a headless writer (`{ userId, send(){} }`), collecting
`session_created` ids and assistant text; other providers produce an error run.
Timeout: `SCHEDULED_TASK_TIMEOUT_MS` (default 1800000) then error + best-effort abort.
Test seam: when `SCHEDULED_TASK_DRY_RUN=1`, skip `queryClaudeSDK` entirely and finish the run
as `success` with `output = '[dry-run] <prompt>'` and `sessionId = null`. This keeps the
end-to-end verification deterministic and token-free.

### `server/scheduled-tasks/service.js`
```js
export function createScheduler(deps?): { tick(), start(), stop(), runNow(taskId), state() }
export function startScheduledTaskService(): void
export function stopScheduledTaskService(): void
export async function runScheduledTaskNow(taskId): Promise<{ run } | { error: 'not_found' }>
export function getSchedulerState(): { running, tickMs, inFlight: string[] }
```
Tick: `listDueTasks(now)` → for each id not already in flight: advance `nextRunAt` first
(crash-safe, documented), then `startTaskRun`, then `advanceTask` with the result.
One-shot tasks get `nextRunAt = null`. `SCHEDULED_TASKS_ENABLED` (default on),
`SCHEDULED_TASKS_TICK_MS` (default 30000).

### REST `/api/scheduled-tasks` (mounted with `authenticateToken`)
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/` | `?status=active\|paused\|all&search=` | `{ tasks: Task[] }` |
| POST | `/` | `{ title, prompt, projectPath, provider?, model?, rule }` | 201 `{ task }` / 400 `{ error, code }` |
| GET | `/:id` | — | `{ task }` / 404 `{ error, code:'not_found' }` |
| PATCH | `/:id` | any of `{ title, prompt, projectPath, model, enabled, rule }` | `{ task }` / 404 / 400 |

PATCH semantics: `enabled: false` clears `nextRunAt` to `null`; re-enabling (`enabled: true`)
recomputes `nextRunAt` from now; changing `rule` recomputes `nextRunAt`; a `once` task whose
`at` is in the past is rejected with `invalid_schedule_time`.
| DELETE | `/:id` | — | `{ id, deleted: true }` / 404 |
| POST | `/:id/run` | — | 202 `{ run }` (status 'running') / 404 |
| GET | `/:id/runs` | `?limit=20&offset=0` | `{ runs, total }` / 404 `{ error, code:'not_found' }` |

Task JSON (camelCase):
`{ id, title, prompt, projectPath, provider, model, kind, rule, nextRunAt, lastRunAt,
lastStatus, lastError, enabled, runCount, createdAt, updatedAt }`
Run JSON: `{ id, taskId, status, trigger, scheduledFor, startedAt, finishedAt, sessionId, output, error }`

## 5. Frontend

`ScheduledTasksLauncher` (sidebar footer button) opens `ScheduledTasksPanel` (full-screen
overlay, portal): search + status filter, task list (title, `describeRule`-equivalent
frequency text, next run, last status, enable toggle, run-now, edit, delete), task editor
dialog (create/edit incl. rule editor + project picker from `GET /api/projects`), and a
per-task run history list (`GET /:id/runs`). i18n namespace `scheduledTasks` (en + zh-CN;
other locales fall back to en). Uses `authenticatedFetch` from `src/utils/api.js`.

## 6. Agent tools (工具调用路径) — added in the second iteration

Besides the manual UI form, an agent session can create and manage scheduled tasks through
the in-process SDK MCP server (`mcp__internal__*`), mirroring DSH's
`schedule_create / schedule_list / schedule_update / schedule_delete`.

Tools are registered by `server/scheduled-tasks/tools.js` and mounted by
`createInternalToolsServer({ projectPath })` in `server/claude-sdk.js`; the session's
`cwd` becomes the default target project. All eight names are appended to
`sdkOptions.allowedTools` so they never raise an approval prompt. Set
`SCHEDULED_TASKS_TOOLS=0` to omit them.

Tasks are **project-scoped**: a tool call only sees/edits tasks whose `project_path`
equals the calling session's cwd (normalized). A task outside that scope behaves as
`not_found`.

| Tool | Args | Returns |
|---|---|---|
| `schedule_create` | `prompt`, `title`, optional `project_path`, and **exactly one** of `after_seconds` \| `at` \| `every_seconds` \| `daily{time,time_zone}` \| `weekly{time,time_zone,weekdays}` \| `cron{expression,time_zone}` | task view |
| `schedule_list` | optional `include_paused` (default false) | `{ tasks: Task[] }` |
| `schedule_get` | `id` | `{ task, recent_runs }` (last 5 runs) |
| `schedule_update` | `id`, optional `title`, optional `prompt`, optional one selector | task view |
| `schedule_delete` | `id` | `{ id, deleted }` |
| `schedule_run` | `id` | `{ run }` (trigger `manual`, status `running`) |
| `schedule_pause` | `id` | task view, `enabled: false`, `nextRunAt: null` |
| `schedule_resume` | `id` | task view, `enabled: true`, recomputed `nextRunAt` |

Selector → stored rule mapping (identical to the REST layer):
`after_seconds` → `once` at now+N; `at` → `once`; `every_seconds` → `interval`;
`daily`/`weekly`/`cron` → the matching rule with `time_zone` → `timeZone`.

Every tool returns one JSON text block and never throws; failures are
`{ code, message }` with the codes from §4 plus `not_found`, `in_flight`,
`invalid_input`, `internal_error`.

Shared logic lives in `server/scheduled-tasks/management.js` (task views, selector→rule
mapping, create/update/pause/resume/delete/run), used by **both** the REST routes and the
tools so the two paths cannot drift.

## 7. Script gate (脚本门控) — added in the third iteration

A task may run a **shell script first**; the script's stdout is a JSON envelope that decides
whether the agent runs at all and what prompt it receives. This is the token-saving path:
a script that reports "nothing to do" never reaches the model.

Task gains two optional fields:
- `command` (string) — shell command executed with `sh -c` in `projectPath` before the agent.
- `commandTimeoutSeconds` (int, default 60, 1..3600).

### Run flow when `command` is set
1. Create the run row (status `running`) as today.
2. Execute the command with cwd = `projectPath` and env inherited plus
   `SCHEDULED_TASK_ID`, `SCHEDULED_TASK_TITLE`, `SCHEDULED_TASK_PROJECT`.
3. Record stdout (truncated to 20000 chars) in `script_output` and the exit code in
   `script_exit_code`.
4. Non-zero exit, spawn failure or timeout => run `error` (`script_exit_<code>` /
   `script_failed` / `script_timeout`) and **no agent call**.
5. Parse JSON: `JSON.parse(stdout.trim())`; if that fails, try the last non-empty line.
   Still unparseable, or parsed to a non-object => run `error` `invalid_script_output`,
   **no agent call**.
6. Decide from the envelope (unknown keys are ignored):

| envelope | outcome |
|---|---|
| `{ "skip": true, "reason"?: "..." }` | run `skipped`, no agent call; `output` = reason |
| `{ "prompt": "<non-empty string>" }` | agent runs with that prompt |
| `{ "skip": false }` (no prompt) | agent runs with the task's static `prompt` |
| anything else (empty object, no prompt, non-boolean `skip`) | run `error` `invalid_script_output`, no agent call |

7. The effective prompt is stored on the run as `prompt_used`; the agent then runs exactly as
   in §4. Manual `schedule_run` goes through the same gate. `SCHEDULED_TASKS_COMMANDS=0`
   makes a task that has a `command` fail with `commands_disabled` instead of executing it.

The `SCHEDULED_TASK_DRY_RUN` seam from §4 covers the **agent call only**: the script gate is
not a model call, so it must still execute in dry-run mode, and the dry-run output must echo
the **effective** prompt (`[dry-run] <effective prompt>`). Otherwise the gate could not be
verified without spending model tokens.

### Schema additions
- `scheduled_tasks.command TEXT`, `scheduled_tasks.command_timeout_seconds INTEGER`
- `scheduled_task_runs.status` additionally accepts `skipped`
- `scheduled_task_runs.script_exit_code INTEGER`, `script_output TEXT`, `prompt_used TEXT`

Existing databases get the columns through `addColumnIfMissing`; existing rows keep
`command = NULL` and behave exactly as before.

### Surface
- Task JSON: `command`, `commandTimeoutSeconds`.
- Run JSON: `status` may be `skipped`; adds `scriptExitCode`, `scriptOutput`, `promptUsed`.
- REST POST/PATCH accept `command` / `commandTimeoutSeconds` (explicit `null` clears them).
- `schedule_create` / `schedule_update` accept `command` and `command_timeout_seconds`;
  their descriptions document the envelope so an agent can author gated tasks.
- Web UI: optional "Script gate" section in the task editor (command + timeout + contract
  hint), a marker on cards whose task has a command, a `Skipped` status pill, and script
  output / effective prompt in the run history.

### §6.1 Precedence over Claude Code's built-in Cron tools (added in the fourth iteration)

The `claude_code` tool preset that claudecodeui passes to the SDK also ships Claude Code's
own **`CronCreate` / `CronList` / `CronDelete`**. Those persist to
`<project>/.claude/scheduled_tasks.json`, are invisible in the app's Scheduled tasks panel
and auto-expire after 7 days, so an agent that picks them produces a task the user cannot see.
The app's own `schedule_*` tools are the authoritative scheduler and must win by default.

Two mechanisms, both required:

1. **Tool descriptions (stated in the MCP schemas).** Every `schedule_*` tool description
   says, in its first sentence, that these tools are the preferred scheduler for this app and
   that the built-in `CronCreate` / `CronList` / `CronDelete` must not be used. The
   `schedule_create` description additionally explains why (separate store, not visible in
   the UI, 7-day expiry).
2. **Soft by default, blockable on request (superseded by §6.3).** The descriptions carry the
   preference; the runtime does **not** remove the built-in tools unless
   `SCHEDULED_TASKS_BLOCK_BUILTIN_CRON=1` is set, so an explicit user request for a built-in
   scheduler can still be honoured. `SCHEDULED_TASKS_TOOLS=0` (our tools absent) never blocks the
   built-ins, so an agent is never left without any scheduler.

### §6.2 Precedence wording against every runtime, and the storage map (fifth iteration)

The precedence rule now names **every** scheduler built into the agent runtime, not just Claude
Code's, carries the user's exception, and the descriptions also state where the data lives so the
model never has to guess (or invent) a store.

- **First sentence of all eight descriptions**: these tools are the preferred scheduler for this
  app and outrank any scheduler built into the agent runtime (Claude Code's `CronCreate`,
  `CronList`, `CronDelete`, Codex, Cursor, Gemini or any similar built-in); a built-in scheduler
  is used **only when the user explicitly asks for that specific built-in one**.
- **Storage note, appended to `schedule_create` and `schedule_list`**: task definitions and run
  history live in this app's SQLite database — `scheduled_tasks` and `scheduled_task_runs` in the
  `DATABASE_PATH` database (default `~/.cloudcli/auth.db`); each run stores the agent session it
  started, whose transcript is the project's normal session log
  `~/.claude/projects/<project>/<sessionId>.jsonl`. A built-in scheduler keeps its jobs in a
  separate store (Claude Code: `<project>/.claude/scheduled_tasks.json`), which is why they never
  appear in `schedule_list` or in the app's panel, and why they expire after 7 days.
- **Soft preference, with an opt-in hard block (superseded by §6.3).** By default
  `disallowedTools` is passed through untouched, so the model can honour a user who explicitly
  asks for a built-in scheduler; the descriptions are what steer it to ours. Setting
  `SCHEDULED_TASKS_BLOCK_BUILTIN_CRON=1` merges `CronCreate`/`CronList`/`CronDelete` into
  `disallowedTools` (de-duplicated, the configured list preserved) for operators who want the
  hard guarantee. Codex, Cursor, Gemini and Copilot are separate CLIs with no equivalent hook in
  this app, so for those providers the description is guidance only.

### §6.3 Soft preference by default (sixth iteration)

The hard block introduced in §6.1 contradicted the exception §6.2 states: with the Cron tools
removed from its context, the model cannot honour a user who explicitly asks for them. The
default is therefore reversed:

- `mapCliOptionsToSDK` passes the configured `disallowedTools` through **untouched** by default;
  the tool descriptions are the only steering.
- `SCHEDULED_TASKS_BLOCK_BUILTIN_CRON=1` opts into the old hard behaviour (merge
  `CronCreate`/`CronList`/`CronDelete` in, de-duplicated, configured entries preserved).
- `SCHEDULED_TASKS_TOOLS=0` still never blocks the built-ins.
- `SCHEDULED_TASKS_KEEP_BUILTIN_CRON` is removed: keeping the built-ins is now the default, so the
  flag has no meaning.
## 9. Scheduled-task sessions: origin tag + hide/show（第七轮）

每次运行都可能在项目里留下一个普通 Claude 会话。这些会话需要（a）可追溯是哪条任务启动的，
（b）默认从侧栏隐藏，（c）在前端能被识别并自由显示/隐藏。

### 9.1 追溯（权威来源）

`scheduled_task_runs.session_id` 就是唯一权威映射（每次运行一行，含 `task_id`）。新增索引
`idx_scheduled_task_runs_session ON scheduled_task_runs(session_id)`，并新增仓储 API：

```ts
getSessionOrigins(sessionIds: string[]): Map<string, { taskId: string; taskTitle: string; startedAt: string | null }>
getAllScheduledTaskSessionIds(): Set<string>
```

同一 session 多次出现时取 `started_at` 最新的一条；`taskTitle` 取自 `scheduled_tasks.title`
（任务已被删除时回退为 task id）。`getAllScheduledTaskSessionIds` 用一条 SQL 返回全部有会话的 id。

### 9.2 会话装饰与过滤（server/database/db.js，照 auto-doc 的写法）

- `applyScheduledTaskOrigin(sessions, provider)`：给匹配的会话加
  `session.scheduledTaskOrigin = { taskId, taskTitle }`（仅 claude）。
- `filterHiddenScheduledTaskSessions(sessions)`：`app_config.scheduled_task_hide_sessions`
  不为 `'false'`（**默认隐藏**）时把这些会话从数组里剔除；必须在 apply 之后调用。
- `projects.js`：在 `getProjects` 与 `getSessions` 里紧跟 auto-doc 的那两行调用；并把
  `getAllScheduledTaskSessionIds()` 并入 `buildExcludedSessionIds()`（隐藏开启时），保证
  `getProjects` / `searchConversations` / 分页口径一致。`buildExcludedSessionIds` 需
  导出以便验收脚本直接断言。

### 9.3 设置

`app_config.scheduled_task_hide_sessions`（默认 `true`）。自动化设置接口扩展：
`GET /api/settings/automations` 额外返回 `hideScheduledTaskSessions`，
`POST` 接受同名字段（与 `hideAutoDoc` 同构）。

### 9.4 前端

- **行内 tag**：会话行在 `session.scheduledTaskOrigin` 存在时渲染一个小 `Clock` 图标
  （meta 行内），tooltip 为 `由定时任务「<title>」启动`（i18n key
  `scheduledTaskSession.badge`，en + zh-CN）。tag 与隐藏开关无关——会话出现在哪就标记到哪。
- **随手开关**：侧栏会话列表头部加一个时钟切换按钮，即时显示/隐藏定时任务会话；选择写入
  设置接口（跨刷新保留），首次加载的默认值来自服务端设置。
- **设置页**：`AutomationsSettingsTab` 在 auto-doc 那个开关旁加一个同款开关，绑定
  `hideScheduledTaskSessions`。

### 9.5 验收

新增 lead 脚本 `scripts/verify-session-origin.mjs`：断言索引存在、两个仓储方法正确（含"最新
run 胜出"与"任务已删回退 task id"）、装饰函数打标正确、隐藏开关开/关时过滤结果相反、
`buildExcludedSessionIds()` 在隐藏开启时包含这些会话。

默认隐藏意味着**已存在**的历史会话会立刻从侧栏消失（当前 4 个）；用户可用侧栏开关或设置页
随时显示。

## 10. Presets（安装包）+ per-task workspace（第八轮，issue #4）

Issue #4 asks for three things: (a) **presets** — an installable package holding several scheduled
tasks, enable/disableable as a whole, with a set of built-ins; (b) **custom presets** built by the
user out of existing tasks; (c) a **planned on-disk layout** for everything a task owns (task root,
per-run data, global state, temp data), announced to the agent when the task is created so it never
stores state ad hoc.

### 10.1 Model

- **Preset** = a named bundle of task *templates*. `source` is `builtin` (shipped catalog) or
  `custom` (user made). A preset is *installed* into a project: installation materializes one real
  `scheduled_tasks` row per template, linked back through `preset_id` + `preset_task_id`.
- **Built-in catalog** is version-controlled at `server/scheduled-tasks/presets/builtin/<id>.json`
  and loaded by `server/scheduled-tasks/presets.js`. The catalog is authoritative for
  name/description/icon/template content: every `listPresets()` re-seeds catalog rows
  (insert when missing, refresh name/description/icon/version/templates when changed) while keeping
  the user-owned column `enabled` (installed state is derived from the linked tasks).
- **Enable/disable is whole-preset**: it flips `scheduled_task_presets.enabled` and every task
  linked by `preset_id` (`enabled` + `nextRunAt`).
- **Custom presets** are snapshots of existing tasks in one project. For the agent-tool path they
  are project-scoped exactly like tasks (§6): `listPresets` / `getPreset` / `updatePreset` /
  `setPresetEnabled` / `deletePreset` treat a custom preset whose `project_path` does not match the
  calling project as `not_found`. **Installing is deliberately unscoped**: a preset (builtin or
  custom) is a portable package and `installPreset` may materialize it into any requested target
  project — that is what makes a custom preset shareable between projects. The install target never
  has to equal the preset's own `project_path`; `project_path` only gates discovery and mutation.

### 10.2 Database (additive)

```sql
CREATE TABLE IF NOT EXISTS scheduled_task_presets (
  id TEXT PRIMARY KEY,                 -- builtin: catalog id; custom: crypto.randomUUID()
  user_id INTEGER,
  source TEXT NOT NULL,                -- 'builtin' | 'custom'
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  version TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,  -- whole-preset switch
  project_path TEXT,                   -- custom presets: owning project; builtin: NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_task_preset_tasks (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES scheduled_task_presets(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  prompt TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  model TEXT,
  kind TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  command TEXT,
  command_timeout_seconds INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_presets_source ON scheduled_task_presets(source);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_preset_tasks_preset
  ON scheduled_task_preset_tasks(preset_id, position);
```

`scheduled_tasks` gains `preset_id TEXT` and `preset_task_id TEXT`, plus
`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_preset ON scheduled_tasks(preset_id)`.
Existing databases get the columns through `addColumnIfMissing`; existing rows keep NULL and behave
exactly as before.

Repository additions (`server/modules/database/repositories/scheduled-tasks.db.ts`, all rows
snake_case):
```ts
createPreset(input: { id?, userId?, source, name, description?, icon?, version?, enabled?, projectPath? }): ScheduledTaskPresetRow
getPreset(id): ScheduledTaskPresetRow | undefined
listPresets(opts?: { source?: 'builtin'|'custom', projectPath?: string|null }): ScheduledTaskPresetRow[]
updatePreset(id, patch: Partial<{ name, description, icon, version, enabled, projectPath, userId }>): ScheduledTaskPresetRow | undefined
deletePreset(id): boolean                       // also deletes its preset_tasks rows
replacePresetTasks(presetId, tasks: PresetTaskInput[]): ScheduledTaskPresetTaskRow[]
listPresetTasks(presetId): ScheduledTaskPresetTaskRow[]     // ordered by position, created_at
listTasksByPreset(presetId): ScheduledTaskRow[]             // ordered by created_at
```
`listPresets({ projectPath })` returns every builtin row plus custom rows whose `project_path`
matches (normalized with `normalizeProjectPath`, same comparison as `sameProjectPath`); when
`projectPath` is omitted, all rows. `updatePreset` bumps `updated_at`.
`createTask`/`updateTask` must accept `presetId`/`presetTaskId` so install can link rows.

### 10.3 Module contract — `server/scheduled-tasks/presets.js`

```js
export const BUILTIN_PRESET_DIR;                      // absolute dir of the shipped catalog
export function loadBuiltinCatalog();                 // BuiltinPreset[] sorted by id; throws { code:'invalid_catalog' } on malformed JSON
export function createPresetService(deps = {});       // deps: { repo, rules, catalog, workspace, logger, now }
```
Catalog file shape (`<id>.json`), validated on load: `{ id, name, description?, icon?, version?,
tasks: [{ id, title, description?, prompt, provider?, model?, rule, command?,
commandTimeoutSeconds? }] }`. Ids are lower-kebab; `tasks[].id` is unique inside the preset.

Service methods (same result convention as `createManagement`: `{ ok:true, ... }` or
`{ ok:false, code, message, httpStatus? }`):
```js
listPresets({ projectPath } = {})                       // -> { ok:true, presets }
getPreset(id, { projectPath } = {})                     // -> { ok:true, preset } | not_found
installPreset(id, { projectPath, enabled, userId } = {})// -> { ok:true, preset, tasks, created, updated }
setPresetEnabled(id, enabled, { projectPath } = {})     // -> { ok:true, preset, tasks }
createCustomPreset(input)                               // -> { ok:true, preset }
updatePreset(id, patch, { projectPath } = {})           // custom only -> { ok:true, preset }
deletePreset(id, { purge } = {}, { projectPath } = {})  // -> { ok:true, id, deleted:true, removedTasks }
```
Preset JSON (camelCase):
`{ id, source, name, description, icon, version, enabled, projectPath, taskCount,
installedProjects, tasks: PresetTask[], createdAt, updatedAt }`
`PresetTask` = `{ id, presetId, title, description, prompt, provider, model, kind, rule, command,
commandTimeoutSeconds, position }`; `installedProjects` is the distinct set of `project_path`
values of the tasks linked by `preset_id`; `taskCount` = `tasks.length`.

Install semantics (frozen):
1. Re-seed the builtin catalog first.
2. `projectPath` is required. `enabled` defaults to **`true`** — installing a preset starts it;
   pass `enabled: false` to install it paused. The preset lookup for install is **not** scoped:
   `installPreset` never returns `not_found` because the target project differs from the preset's
   `project_path` (see §10.1). Scope matching applies to the discovery and mutation methods only.
3. For every template, match an existing task by `(preset_id, preset_task_id, project_path)`
   (normalized): update title/prompt/rule/command/provider/model, do **not** duplicate. A template's
   `description` is catalog metadata only — `scheduled_tasks` has no description column, so it is not
   persisted on the materialized task.
   Otherwise create one. `enabled` follows the effective value; `nextRunAt` is recomputed from now
   (interval rules get a fresh `anchorMs`) and is `null` when disabled.
4. Set `preset.enabled` to the effective value. Installing twice with the same arguments is
   idempotent (only `updated_at` moves).
5. Result: `{ preset, tasks, created: string[], updated: string[] }`, HTTP 200.
6. Templates whose rule has no upcoming run (`computeNextRun` → null, e.g. a past `once`) are
   skipped and reported in `skipped: string[]` (template ids), never a hard failure.

Enable/disable semantics: flip `preset.enabled`; for every linked task set `enabled` and
`nextRunAt` (`null` when disabling, recomputed from now when enabling, interval re-anchored).
When `projectPath` is given, only the tasks installed in that project are toggled while the preset
row's `enabled` flag itself is global. A preset that is not installed yet still records the flag and returns `tasks: []` (the flag is
only a UI hint until it is installed: `installPreset` without an explicit `enabled` always installs
enabled).

Custom preset creation: `{ name, description?, projectPath, taskIds }`; `taskIds` are existing
task ids in scope, at least one, order preserved as `position`; each template snapshots
prompt/rule/command/provider/model. New preset `enabled: false`, `source: 'custom'`. Errors:
`invalid_input`, `not_found`.

Update: `name`/`description`/`icon` only, custom presets only, otherwise
`{ ok:false, code:'builtin_preset' }`.

Delete: custom → drop the preset and its templates; the linked real tasks are deleted only when
`purge !== false` (REST default `purge=1`, agent tools never purge). Builtin → uninstall: delete
the linked tasks, set `enabled:false`; the catalog row and templates stay. `removedTasks` is the
count of deleted real tasks.

New error codes: `builtin_preset`, `invalid_catalog`, `no_tasks`.

### 10.4 Per-task root (`server/scheduled-tasks/workspace.js`)

Root: `process.env.SCHEDULED_TASK_DATA_DIR` when set, otherwise
`path.join(os.homedir(), '.claudecodeui', 'scheduled-tasks')`. Every task owns exactly one root
directory, `<root>/<taskId>/`. The framework writes only its own files there; everything else in
the root belongs to the task:

```
<root>/<taskId>/
  task.json      machine snapshot of the task definition (schemaVersion, id, title, projectPath, provider, model, kind, rule, command, commandTimeoutSeconds, url?, updatedAt)
  prompt.md      current task prompt (copy; the DB row stays authoritative)
  README.md      the layout contract, generated on create/update (see below)
  runs/<runId>/
    run.json     run metadata + workspace paths (see below)
    prompt.md    the full prompt sent to the agent (workspace block + effective prompt)
    output.md    final assistant output / error text
    logs/        script-gate stdout and other logs
```

The framework does **not** create, prescribe or wipe a `state/` or `tmp/` directory, and it never
removes task files: how a task organizes its root and where it keeps state across runs is the task's
own decision (a task may keep state in the root, pass its own path in as a parameter, or use anything
else). `SCHEDULED_TASK_STATE_DIR`, `SCHEDULED_TASK_TMP_DIR` and `SCHEDULED_TASK_KEEP_RUN_TMP` are
**retired** by this change. Migration: `$SCHEDULED_TASK_STATE_DIR` → a directory of the task's choosing
under `$SCHEDULED_TASK_DIR` (e.g. `$SCHEDULED_TASK_DIR/state`); `$SCHEDULED_TASK_TMP_DIR` → e.g.
`$SCHEDULED_TASK_DIR/tmp`.

```js
export const SCHEDULED_TASK_SCHEMA_VERSION = 1;
export function tasksRoot();
export function isWorkspaceEnabled();          // SCHEDULED_TASKS_WORKSPACE=0 disables everything
export function taskDir(taskId); taskRunsDir(taskId);
export function runDir(taskId, runId);
export function ensureTaskWorkspace(task);      // task root + task.json + prompt.md + README.md
export function ensureRunWorkspace(task, run, { effectivePrompt } = {});   // run dir + run.json + prompt.md + logs/
export function finalizeRunWorkspace(task, run, patch);  // output.md, run.json status
export function workspaceEnv(task, { runId } = {});      // DIR/RUN_ID/RUN_DIR for gate + agent
export function workspacePromptBlock(task, { runId } = {});  // markdown block prepended to the prompt
```
Every function is a no-op returning `null` when `isWorkspaceEnabled()` is false, and all of them are
best-effort: filesystem failures are logged, never thrown to the caller (a task must still run).
`run.json` fields: `{ schemaVersion, runId, taskId, title, projectPath, trigger, scheduledFor,
startedAt, finishedAt, status, sessionId, scriptExitCode, error, workspace: { root, taskDir,
runDir } }`.

Env added for every run — to the **script gate and the agent** (§13.3), never replacing `process.env`:
`SCHEDULED_TASK_DIR` (the task root), `SCHEDULED_TASK_RUN_ID`, `SCHEDULED_TASK_RUN_DIR`.

Prompt block (`workspacePromptBlock`) is prepended to the prompt the agent receives, in English,
and states: the task id/title/run id, the project directory the agent may edit, the task root
("this directory belongs to the task. Organize it however the task wants; keeping long-lived state,
caches or notes there makes them survive across runs, but how (or whether) to do that is the task's
own choice"), the framework files already written there (`task.json`, `prompt.md`, `README.md`) and
this run's directory (`runs/<runId>/` with `run.json`, `prompt.md`, `output.md`, `logs/`), closing
with the preference "prefer keeping files the task generates inside the task root or the project
directory" (guidance, not a hard boundary). The same layout text is written to `README.md` and
appended to the `schedule_create` / `schedule_preset_install` tool descriptions, so an agent
authoring a task knows the contract before the first run.

Runner integration (`server/scheduled-tasks/runner.js`):
1. In `execute()`, before the script gate: `ensureTaskWorkspace(task)`, `ensureRunWorkspace(task, run)`.
2. The script gate env gains `predefinedVarsEnv(task, { cwd, workspaceVars })` (§13.1) — merged over
   `process.env`, never replacing it.
3. After the gate decision, the agent is called with the workspace block, the §13.5 predefined block,
   the optional §12.6 parameters block and the effective prompt. `prompt_used` keeps the pre-block
   effective prompt (unchanged §7 semantics) and `runs/<runId>/prompt.md` stores the full agent-facing
   text.
4. `finishOnce` calls `finalizeRunWorkspace(...)` (best-effort) with status/output/error/sessionId/
   script fields; nothing under the task root is ever removed.
5. Dry-run (`SCHEDULED_TASK_DRY_RUN=1`) still creates the workspace and writes `prompt.md`/
   `output.md`, so the layout is verifiable without model calls. Dry-run output stays
   `[dry-run] <effective prompt>` (without the block).

Task lifecycle: `management.createTask`/`updateTask` call `ensureTaskWorkspace` (best-effort) so
the root, `README.md` and `task.json` exist right after creation. `DELETE /api/scheduled-tasks/:id`
accepts `?purge=1` to remove `<root>/<taskId>` (default: data is kept).

### 10.5 REST additions (same router, same auth)

Preset routes are registered **before** `/:id`, otherwise `GET /presets` would be captured by
`GET /:id`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/presets` | `?projectPath=` | `{ presets: Preset[] }` |
| POST | `/presets` | `{ name, description?, projectPath, taskIds }` | 201 `{ preset }` / 400 |
| GET | `/presets/:id` | `?projectPath=` | `{ preset }` / 404 |
| PATCH | `/presets/:id` | `{ name?, description?, icon? }` | `{ preset }` / 400 `builtin_preset` |
| POST | `/presets/:id/install` | `{ projectPath, enabled? }` | `{ preset, tasks, created, updated, skipped }` |
| POST | `/presets/:id/enable` | `/disable` | `{ projectPath? }` | `{ preset, tasks }` |
| DELETE | `/presets/:id` | `?purge=0` to keep the installed tasks | `{ id, deleted: true, removedTasks }` |
| DELETE | `/:id` | `?purge=1` removes the task workspace | `{ id, deleted: true }` |

### 10.6 Agent tools (extend §6)

Four new names appended to `SCHEDULE_TOOL_NAMES` (and to `allowedTools` in `claude-sdk.js` through
the existing export — no new wiring), each opening its description with the §6 precedence sentence:

| Tool | Args | Returns |
|---|---|---|
| `schedule_preset_list` | optional `include_catalog` (default true) | `{ presets: Preset[] }` |
| `schedule_preset_install` | `id`, optional `project_path` (defaults to the session cwd), optional `enabled` | `{ preset, tasks, created, updated, skipped }` |
| `schedule_preset_set_enabled` | `id`, `enabled` | `{ preset, tasks }` |
| `schedule_preset_create` | `name`, optional `description`, optional `task_ids` (default: every task of the session project) | `{ preset }` |

Tool scoping: builtin presets always visible; custom presets only when `project_path` matches the
session cwd; install always targets the session cwd (or `project_path` when given). The tools never
purge real tasks on delete (there is no preset delete tool in this iteration).

### 10.7 Frontend

`ScheduledTasksPanel` gains a **Presets** section (tab or segmented switch next to the task list):
- **Catalog**: builtin presets with name/description/task count and per-task preview; actions
  *Install into project* (project picker), *Enable/Disable* (whole preset), *Uninstall*.
- **Custom presets**: *New preset* opens a dialog to pick tasks of the current project, name the
  preset and save it; presets list shows installed state per project and the same enable/disable,
  install and delete actions. Deleting a custom preset asks whether to also delete the tasks it
  installed.
- i18n keys in `scheduledTasks` namespace (`en` + `zh-CN`; other locales fall back to en).

### 10.8 Write scopes (one owner per file)

| Owner | Files |
|---|---|
| backend-db | `server/modules/database/schema.ts`, `migrations.ts`, `index.ts`, `repositories/scheduled-tasks.db.ts`, `repositories/scheduled-tasks.db.test.ts` |
| backend-runtime | `server/scheduled-tasks/presets.js` (+test), `presets/builtin/*.json`, `workspace.js` (+test), `management.js`, `management.test.js` (new), `runner.js` (+test), `service.js` (+test), `tools.js` (+test), `server/routes/scheduled-tasks.js` (+test) |
| frontend | `src/components/scheduled-tasks/**`, `src/i18n/locales/{en,zh-CN}/scheduledTasks.json`, `src/i18n/config.js` |
| verify | `scripts/verify-scheduled-task-presets.mjs` |
| lead | `docs/scheduled-tasks.md` |

### 10.9 Acceptance

`node scripts/verify-scheduled-task-presets.mjs` boots the real server (throwaway DB, temp
`SCHEDULED_TASK_DATA_DIR`, `SCHEDULED_TASK_DRY_RUN=1`) and asserts: the builtin catalog seeds and
lists; install is idempotent and materializes tasks; a second install with `enabled:false` pauses
them; enable/disable flips the whole bundle; a custom preset can be built from tasks and installed
elsewhere; uninstall removes tasks without touching the catalog; the on-disk layout
(`task.json`/`README.md`/`prompt.md`/`state/`/`runs/<runId>/{run.json,prompt.md,output.md,logs}`)
appears after a dry run; the script gate sees the `SCHEDULED_TASK_*_DIR` env vars; and
`?purge=1` removes the task directory.

## 11. AutoDoc retirement → covered by a built-in preset（第九轮，issue #4 后续）

Issue #4 follow-up: AutoDoc is taken offline. The same job — keep a project's docs in sync with the
recent conversations — is now expressed as a normal, visible Scheduled Task preset, which is simpler
than a separate background feature with its own config surface.

### 11.1 What is removed

AutoDoc is **deleted**, not merely switched off:

| Surface | File | Action |
|---|---|---|
| Timer + fork/summarize job | `server/auto-doc.js` | delete the module |
| Timer start | `server/index.js` | drop the import and the `startAutoDocTimer()` call |
| Settings + legacy routes | `server/routes/settings.js` | drop `AUTO_DOC_DEFAULT_*`, the auto-doc fields of `readAutomationsConfig` / `applyAutomationsConfig`, and the `GET/PUT /auto-doc` routes |
| Session decoration | `server/database/db.js` | drop `markAsAutoDocSession`, `getAutoDocSessionIds`, `getAllAutoDocSessionIds`, `getLastAutoDocTimestamps`, the `isAutoDoc` flag and the `lastAutoDocAt` decoration |
| Projects payload | `server/projects.js` | keep the exclusion mechanism for hidden + scheduled-task sessions; drop the auto-doc id source and rename the `autoDocPreFilter` seam to `sessionExclusionFilter` |
| Settings UI | `src/components/settings/**` | tab id `auto-doc` → `automations`, holding only the scheduled-task session toggle |
| Sidebar | `src/components/sidebar/**` | drop the `hideAutoDoc` state/filter and every `isAutoDoc` / `lastAutoDocAt` badge |
| Types | `src/types/app.ts` | drop `isAutoDoc` / `lastAutoDocAt` |
| i18n | `src/i18n/locales/*/settings.json` | drop the auto-doc keys (en, zh-CN, de, ja, ko, ru) |

Kept on purpose (no destructive migration): the `auto_doc_sessions` table and its rows stay in the
database but nothing reads or writes them any more; sessions previously forked by AutoDoc become
ordinary sessions (no longer hidden or badged); the inert `auto_doc_*` rows in `app_config` stay;
`docs/superpowers/specs/2026-05-03-auto-summary-design.md` stays as historical material.

### 11.2 Settings contract after the change

`GET /api/settings/automations` → `{ hideScheduledTaskSessions: boolean }` (default `true`).
`POST /api/settings/automations` accepts `{ hideScheduledTaskSessions?: boolean }`; unknown or
legacy keys (`hideAutoDoc`, `intervalMs`, `prompt`, `minMessageCount`, `model`, `enabled`) are
ignored, never a 400. `GET/PUT /api/settings/auto-doc` are gone → 404.

### 11.3 Replacement preset（内置 `auto-doc`）

New catalog file `server/scheduled-tasks/presets/builtin/auto-doc.json`, id `auto-doc`, one task
template `auto-doc-docs-refresh` (template ids are unique across the whole catalog — §10.3 — and
`daily-docs-refresh` already owns `docs-refresh`, so the AutoDoc template carries the preset prefix;
the existing preset keeps working untouched):

- Rule: `daily` at 21:00 `Asia/Shanghai` (the user can change it in the panel like any task).
- `command` (script gate, self-contained `node -e`, no extra files): locate the project's Claude
  session directory with the app's own rule (`absolutePath.replace(/[^a-zA-Z0-9]/g, '-')` under
  `~/.claude/projects`), compare the newest transcript's mtime with the cursor kept in
  `$SCHEDULED_TASK_DIR/autodoc-cursor.json` (task-owned path, §10.4), then either print
  `{"skip":true,"reason":"no new conversations since <ts>"}` (no model call) or
  `{"prompt":"<the refresh prompt>"}`.
- `prompt`: read the conversations/changes since the cursor and update the project's docs
  (`docs/` plus `CLAUDE.md` when present); keep notes and the new cursor under the task root
  (the layout of §10.4).
- Generated runs are ordinary sessions of the target project and are hidden from the sidebar by
  default through the existing scheduled-task rule (§9), which replaces AutoDoc's own hiding.

### 11.4 Ownership

| Owner | Files |
|---|---|
| backend-removal | `server/auto-doc.js`, `server/index.js`, `server/routes/settings.js`, `server/projects.js`, `server/database/db.js` + their tests |
| frontend-removal | `src/components/settings/**`, `src/components/sidebar/**`, `src/types/app.ts`, `src/i18n/locales/*/settings.json` |
| preset | `server/scheduled-tasks/presets/builtin/auto-doc.json`, `server/scheduled-tasks/presets.test.js` |
| verify | `scripts/verify-autodoc-retirement.mjs` |
| lead | `docs/scheduled-tasks.md` |

### 11.5 Acceptance

`node scripts/verify-autodoc-retirement.mjs` boots the real server (throwaway DB) and asserts:
1. `GET /api/settings/auto-doc` → 404; `GET /api/settings/automations` returns only
   `hideScheduledTaskSessions`; `POST` ignores legacy auto-doc keys.
2. The timer is gone: no `[auto-doc]` log output, and `auto_doc_sessions` neither grows nor is
   dropped while the server runs.
3. `/api/projects` sessions carry no `isAutoDoc` / `lastAutoDocAt` fields, and a session id present
   in `auto_doc_sessions` comes back as an ordinary session.
4. The `auto-doc` builtin preset seeds and installs (default enabled), and its gate returns
   `skip` with a reason on a project without new conversations (run recorded `skipped`, no model
   call under `SCHEDULED_TASK_DRY_RUN=1`).
Plus the full `npx vitest run`, `tsc --noEmit` for both configs and `eslint src/ server/`.

---

## 12. Parametrized scheduled tasks（第十轮，issue #14）

### 12.1 Model

Every scheduled task may declare **parameters**: named, typed, optionally-defaulted values. At run
time they are **resolved** into a flat string map and exported to both the script gate and the agent
runtime as environment variables, so any code the task runs — the gate shell script, files it
invokes, and the agent's own shell — can read them without knowing anything about this app.

```ts
type ParamType = 'string' | 'number' | 'boolean';

type ParamDef = {
  name: string;              // ^[A-Za-z_][A-Za-z0-9_]{0,63}$, unique case-insensitively
  type?: ParamType;          // default 'string'
  default?: string | number | boolean;
  description?: string;      // <= 500 chars
  required?: boolean;        // default false; only meaningful without a default
};
```

Limits: at most **32** parameters per task; `JSON.stringify(params)` at most **16 KiB**.
Resolved **values** are bounded as well (§12.3): each value at most **4096 characters**, the compact
resolved JSON at most **16 KiB**, and no value may contain NUL (`\u0000`) — these keep the exported
environment far below the OS `E2BIG` limit and bound what a run may persist.

### 12.2 Env contract（framework-agnostic core）

For a task with parameters `{region: 'eu', threshold: 3, dryRun: false}`:

| Variable | Value |
|---|---|
| `SCHEDULED_TASK_PARAM_REGION` | `eu` |
| `SCHEDULED_TASK_PARAM_THRESHOLD` | `3` |
| `SCHEDULED_TASK_PARAM_DRYRUN` | `false` |
| `SCHEDULED_TASK_PARAMS` | `{"region":"eu","threshold":3,"dryRun":false}` (compact JSON) |

* Derived name = `SCHEDULED_TASK_PARAM_` + `name.toUpperCase()`. The `_PARAM_` infix makes a
  collision with the reserved `SCHEDULED_TASK_*` / `SCHEDULED_TASK_*_DIR` variables impossible, and two
  parameters can never collide because names are unique case-insensitively.
* Booleans are `'true'`/`'false'`; numbers use `String(value)`; strings pass through verbatim.
* With no parameters declared **no** `SCHEDULED_TASK_PARAM_*` variable is exported and
  `SCHEDULED_TASK_PARAMS` is not set at all — the §12 parameter namespace is byte-for-byte the
  pre-§12 environment. The §13 built-in parameters live in the **reserved** `SCHEDULED_TASK_*`
  namespace, are always exported (also for zero-parameter tasks) and can never be shadowed by a
  declared parameter.
* `SCHEDULED_TASK_PARAMS` is the framework-neutral escape hatch: a consumer can parse one JSON
  variable instead of knowing each name. Nothing in this section may reference a vendor-specific
  directory, tool or API.

### 12.3 Resolution（precedence, low → high）

1. the `ParamDef.default` stored on the task;
2. the **per-run override** (`POST /:id/run` body / `schedule_run` args / UI *Run with parameters*).

A missing `required` parameter with no value from either source ⇒ the run fails with
`missing_required_param` (recorded on the run row, no gate, no agent call). Type coercion applies to
defaults and overrides alike; an uncoercible default is `invalid_input` at creation, an uncoercible
override is `invalid_input` at request time. An override naming a parameter the task does not declare
is `invalid_input`.

### 12.4 Storage (additive)

| Table | Column | Meaning |
|---|---|---|
| `scheduled_tasks` | `params_json` TEXT NULL | `ParamDef[]` (JSON). NULL/'' ⇒ no parameters |
| `scheduled_task_runs` | `params_json` TEXT NULL | resolved value map for that run (audit/provenance) |
| `scheduled_task_preset_tasks` | `params_json` TEXT NULL | template `ParamDef[]`, copied into the task on install |

Migration uses `addColumnIfMissing` only — no data rewrite. Unreadable/legacy JSON is read as `[]`.

### 12.5 Module contracts

* **`server/scheduled-tasks/params.js` (new, pure — no I/O):** single source of truth.
  * `PARAM_ENV_PREFIX = 'SCHEDULED_TASK_PARAM_'`, `PARAMS_ENV_NAME = 'SCHEDULED_TASK_PARAMS'`
  * `normalizeParamDefs(input)` → `{ ok: true, params } | { ok: false, code: 'invalid_input', message }`
  * `resolveParams(params, overrides)` → `{ ok: true, values, json, env } | { ok: false, code, message }`
  * `paramEnv(params, overrides)` → `Record<string,string> | null` (`null` ⇒ export nothing)
* `management.createTask`/`updateTask` accept `params` (normalized + coerced) and reject on `invalid_input`.
* `runner.execute()`:
  1. resolve params **before** the script gate; on failure `finishOnce(..., 'error', { error })`;
  2. merge `paramEnv` into the script-gate env (after `workspaceEnv`);
  3. pass `env: { ...builtins, ...paramEnv }` in the agent options (§13.3) — `server/claude-sdk.js`
     merges `options.env` into `sdkOptions.env` so the spawned provider CLI inherits them;
  4. prefix the agent prompt with the §12.6 parameters block;
  5. `createRun` stores `params_json` = resolved values.
* REST: `POST /:id/run` accepts `{ params?: Record<string, unknown> }`;
  `POST /presets/:id/install` accepts `{ params?: Record<string, unknown> }`, applied to every
  installed task whose template declares that name.
* Agent tools: `schedule_create` / `schedule_update` gain `params`; `schedule_run` and
  `schedule_preset_install` gain `params`. Every description keeps the §6 precedence sentence.

### 12.6 Agent-facing text

A **Parameters** block is appended to the workspace block. It lists each parameter's name, env
variable, value and description, and states: read them from the environment
(`$SCHEDULED_TASK_PARAM_<NAME>`, or parse `$SCHEDULED_TASK_PARAMS`); the values are fixed for this run;
never hardcode them. It also names the reserved variables. `runs/<runId>/run.json` records `params`.
Tasks without parameters get no block of their own; the prompt is no longer byte-identical to pre-§12, because the always-on §13.5 predefined-variables block is present.

### 12.7 Frontend

* Task form: a **Parameters** section — add/remove rows (`name`, `type`, `default`,
  `description`, `required`) with client-side validation mirroring §12.1.
* Manual run: a *Run with parameters* dialog prefilled with current defaults; blank ⇒ default;
  required-without-default blocks submit.
* Task card/detail: chips per parameter (tooltip = description + env var); a run's history shows the
  resolved values of that run.
* i18n keys in the `scheduledTasks` namespace (`en` + `zh-CN`).

### 12.8 Write scopes (one owner per file)

| Owner | Files |
|---|---|
| backend-params | `server/modules/database/**`, `server/scheduled-tasks/**`, `server/routes/scheduled-tasks.js` (+ test), `server/claude-sdk.js` |
| frontend-params | `src/components/scheduled-tasks/**`, `src/i18n/locales/{en,zh-CN}/scheduledTasks.json` |
| verify | `scripts/verify-scheduled-task-params.mjs` |
| lead | `docs/scheduled-tasks.md` |

### 12.9 Acceptance

`node scripts/verify-scheduled-task-params.mjs` boots the real server (throwaway DB, temp
`SCHEDULED_TASK_DATA_DIR`, `SCHEDULED_TASK_DRY_RUN=1`) and asserts: create-with-params round-trips;
invalid definitions are rejected; a dry run records the resolved values; the gate sees
`SCHEDULED_TASK_PARAM_*` and `SCHEDULED_TASK_PARAMS`; a per-run override wins over the default; a run
missing a required parameter fails with `missing_required_param` and never calls the agent; a task
without parameters exports no `SCHEDULED_TASK_PARAM_*`; and reinstalling a preset preserves the
parameter contract. Plus the full `npx vitest run`, `tsc --noEmit` for both configs and
`eslint src/ server/`.

## 13. Predefined task variables（第十一轮，issue #14 comment 976）

Every run injects a fixed set of **predefined variables**. They are the contract a task should use instead
of hardcoding paths, so the same task works from any directory. Two details are stated identically in three
places — the agent prompt block, the MCP tool descriptions and this section:

1. **Where each variable is readable.** All nine `SCHEDULED_TASK_*` predefined variables are injected into the
   **script gate** environment. The **agent** environment (§13.3) additionally carries `TITLE`, `CWD`,
   `PROJECT` and the declared parameters; the workspace paths and ids reach the agent as text in the
   *Scheduled task workspace* prompt block (§10.4), not as environment variables.
2. **The three ids are different.** `SCHEDULED_TASK_ID` is the scheduled-task row id (stable across the runs
   of that task); `SCHEDULED_TASK_RUN_ID` is this run id; the **chat session id** is created by the provider
   after the run starts, so it is not an environment variable at all — it is `null` for a dry run or a failed
   start and is recorded on the run (run history / `runs/<runId>/run.json` `sessionId`).

### 13.1 The variables

| Group | Name | Variable | Meaning | Script gate env | Agent env |
|---|---|---|---|---|---|
| builtin | `TITLE` | `SCHEDULED_TASK_TITLE` | name of the task | yes | yes |
| builtin | `CWD` | `SCHEDULED_TASK_CWD` | working directory of this run | yes | yes |
| builtin | `PROJECT` | `SCHEDULED_TASK_PROJECT` | absolute path of the project root that owns the task | yes | yes |
| workspace | `ID` | `SCHEDULED_TASK_ID` | scheduled-task row id, stable across its runs — **not** a chat session id | yes | workspace block text |
| workspace | `DIR` | `SCHEDULED_TASK_DIR` | root of the workspace tree of this task | yes | workspace block text |
| workspace | `STATE_DIR` | `SCHEDULED_TASK_STATE_DIR` | durable per-task state (survives across runs) | yes | workspace block text |
| workspace | `TMP_DIR` | `SCHEDULED_TASK_TMP_DIR` | task scratch, wiped at the start of every run | yes | workspace block text |
| workspace | `RUN_ID` | `SCHEDULED_TASK_RUN_ID` | id of this run (not the task id) | yes | workspace block text |
| workspace | `RUN_DIR` | `SCHEDULED_TASK_RUN_DIR` | this run directory (run.json, prompt.md, output.md, logs/) | yes | workspace block text |

Plus the **declared parameters**, exported to both environments as `SCHEDULED_TASK_PARAM_<NAME>` and the
compact JSON `SCHEDULED_TASK_PARAMS` (§12.2).

`PREDEFINED_TASK_VARS` in `server/scheduled-tasks/params.js` is the single source of truth (`group`,
`envName`, `description`, `agentEnv`): the agent prompt block (`predefinedVarsPromptBlock()`) and the MCP
tool descriptions (`tools.js`) are both rendered from it, so they cannot drift. `builtinParamsEnv(task, { cwd })`
produces the three built-in values; `workspaceEnv(task, { runId })` produces the workspace ones (`null` when
`SCHEDULED_TASKS_WORKSPACE=0`).

When a task has no project path (legacy rows), `SCHEDULED_TASK_CWD` falls back to the cwd of the server
process — the same value the script gate is spawned in.

### 13.2 Namespace and collision rules

* Predefined variables live in the **reserved** `SCHEDULED_TASK_*` namespace and are never re-exported as
  `SCHEDULED_TASK_PARAM_*`.
* A declared parameter is always `SCHEDULED_TASK_PARAM_` + `name.toUpperCase()`. The `_PARAM_` infix makes
  the reserved namespace syntactically unreachable, whatever a task declares, so a parameter named `TITLE`,
  `CWD` or `PROJECT` is exported as `SCHEDULED_TASK_PARAM_TITLE` / `..._CWD` / `..._PROJECT` *alongside* —
  never instead of — the predefined variable.
* A per-run override is matched against **declared** names only (§12.3), so `{ "CWD": "/tmp" }` on a task
  that does not declare `cwd` is `invalid_input`; on a task that does declare it, it moves
  `SCHEDULED_TASK_PARAM_CWD` only. Predefined variables cannot be overridden.
* Merge order inside one environment is: `SCHEDULED_TASK_ID`, then the built-in parameters, then
  `workspaceEnv` (§10.4), then the §12 parameters. Those groups write disjoint key sets.

### 13.3 Both execution paths

* **Script gate** (`runner.js: runScriptGate`): the spawned `sh -c` environment is `process.env` +
  `SCHEDULED_TASK_ID` + the built-in parameters + `workspaceEnv` + the parameter variables — all nine
  predefined names plus the parameters.
* **Agent** (`runner.js: execute` -> `options.env`): the built-in parameters (`TITLE`, `CWD`, `PROJECT`) plus
  the parameter variables. `server/claude-sdk.js` merges `options.env` into `sdkOptions.env` but only accepts
  `SCHEDULED_TASK_PARAM_*`, `SCHEDULED_TASK_PARAMS` and the exact `BUILTIN_PARAM_ENV_NAMES` (the three
  built-ins). Everything else in `options.env` is dropped, because that option is reachable from client
  input (the §12.5 security note).
* **Agent, as prompt text**: the *Scheduled task workspace* block spells out the task id, run id, project
  directory, task root, state dir, tmp dir and run dir of this run (§10.4) — that is where the agent reads
  the workspace group.

### 13.4 Relation to the §12.2 zero-parameter contract

§12.2 promised that a task without parameters exports no `SCHEDULED_TASK_PARAM_*`, no `SCHEDULED_TASK_PARAMS`,
and that its environment is byte-for-byte the pre-§12 one. **The first half still holds; the second is
superseded here**: the *parameter namespace* is still untouched for zero-parameter tasks, but every run now
also exports the predefined variables (the gate already had `SCHEDULED_TASK_ID` / `TITLE` / `PROJECT` and the
five workspace variables; `SCHEDULED_TASK_CWD` is new, and the agent-side `options.env` gained `TITLE` /
`CWD` / `PROJECT` where it previously had nothing). The change is additive — no existing variable changes
name or value and no run loses a variable, so a task that ignores the new names is unaffected. The prompt also
gains the always-on block of §13.5, so the prompt of a zero-parameter task is no longer byte-identical to
pre-§12 either; `promptUsed` stays the raw effective prompt.

### 13.5 Agent prompt

`params.js: predefinedVarsPromptBlock()` returns a static block — identical text for every run — headed
`## Predefined scheduled-task variables`. It lists the built-in parameters (script gate env + this session
env) and the workspace variables (script gate env; the same values are spelled out in the workspace block
above), then the user-declared parameters, then the three-id note of §13 (including that the chat session id
is not an environment variable). The runner always prepends it after the §10.4 workspace block and before the
§12.6 Parameters block, and `runs/<runId>/prompt.md` records it. Because the block is static, the actual
values are never copied into prompt text.

### 13.6 MCP tool descriptions

Every `schedule_*` tool description ends with the shared `PREDEFINED_VARS_NOTE` (rendered from
`PREDEFINED_TASK_VARS` and `SESSION_ID_NOTE`): all nine predefined variables with a one-line meaning, the
user-declared `SCHEDULED_TASK_PARAM_<NAME>` / `SCHEDULED_TASK_PARAMS`, which of them the agent also gets as
environment variables versus as workspace-block text, the instruction to read them instead of hardcoding
paths, and the sentence that `SCHEDULED_TASK_ID` is the scheduled-task row id (not the chat session id) while
the session id is recorded on the run.

### 13.7 Frontend

* The Parameters section of the task editor shows a *Predefined variables (always available)* list with
  **every** variable a run exports, grouped into task & run (`ID`, `TITLE`, `PROJECT`, `CWD`), task workspace
  (`DIR`, `RUN_ID`, `RUN_DIR`) and declared parameters (`SCHEDULED_TASK_PARAM_<NAME>`, `SCHEDULED_TASK_PARAMS`),
  each with its meaning, plus the no-hardcode hint. This mirrors §13.1 exactly, including the removal of
  `SCHEDULED_TASK_STATE_DIR`/`SCHEDULED_TASK_TMP_DIR` (§13.4).
* Run history shows a one-line reminder of the predefined variables.
* i18n keys `editor.params.builtins.*` (including `group.task`/`group.workspace`/`group.params`) and
  `runs.builtinsHint` in `en` and `zh-CN`.
* `src/components/scheduled-tasks/utils/params.ts` exports `PREDEFINED_PARAMS` and
  `PREDEFINED_PARAM_GROUPS` to the UI; the server's `PREDEFINED_TASK_VARS` stays the single source of truth.

### 13.8 Write scopes（第十一轮）

| Owner | Files |
|---|---|
| backend-builtins | `server/scheduled-tasks/**`, `server/claude-sdk.js` |
| frontend-builtins | `src/components/scheduled-tasks/**`, `src/i18n/locales/{en,zh-CN}/scheduledTasks.json` |
| verify | `scripts/verify-scheduled-task-params.mjs` |
| lead | `docs/scheduled-tasks.md` |

### 13.9 Acceptance

`node scripts/verify-scheduled-task-params.mjs` additionally asserts **C1–C5**: the script gate of a
zero-parameter task sees all nine predefined variables; a declared parameter named like a predefined one
cannot shadow it and an override targeting a predefined name is rejected; the agent prompt lists every
predefined variable and the session-id note and forbids hardcoding; prompt order is workspace block <
predefined block < §12.6 parameters; and the agent environment carries exactly the three built-in parameters
plus the parameters (never the workspace group). Unit tests: `server/scheduled-tasks/params.test.js`
(metadata + prompt block), `runner.test.js` (both env surfaces), `tools.test.js` (all twelve descriptions
carry every predefined name, the no-hardcode wording and the id clarification), `server/claude-sdk.test.js`
(allowlist) and the frontend tests. Plus the full `npx vitest run`, `tsc --noEmit` for both configs and
`eslint src/ server/`.

## 14. Running count: only a started agent counts（第十二轮）

需求：前端要有一个地方显示「当前有多少个定时任务正在运行」。这里的"运行"是 **agent 已被启动**，
不是"这条 run 还开着"。脚本门控（§7）阶段不算运行：一个最终会 `skipped` 的任务，在被脚本判定跳过
之前的那段时间里也不算运行；只有门控放行、agent 调用真正发起之后才算。

权威判定依据：`scheduled_task_runs.agent_started_at`。

### 14.1 Database (additive)

```sql
ALTER TABLE scheduled_task_runs ADD COLUMN agent_started_at TEXT;  -- NULL = agent 尚未启动
```

走 `addColumnIfMissing(db, 'scheduled_task_runs', 'agent_started_at', 'TEXT')`（`migrations.ts`），
`schema.ts` 的 `CREATE TABLE` 同步补列（新库直接有）。语义：ISO-8601 UTC，NULL 直到 runner
决定调用 agent 的那一刻才写入；`skipped`、门控 `error`、参数错误、provider 不支持的 run 永远是 NULL。

Repository additions（`server/modules/database/repositories/scheduled-tasks.db.ts`）:

```ts
markRunAgentStarted(id: string): ScheduledTaskRunRow | undefined  // 幂等，只写一次：WHERE id = ? AND agent_started_at IS NULL
countRunningAgentRuns(): number    // COUNT(DISTINCT task_id) WHERE status='running' AND agent_started_at IS NOT NULL
failInterruptedRuns(finishedAt: string, error: string): number    // status='running' -> 'error' + finished_at/error，返回受影响行数
```

`ScheduledTaskRunRow` 新增 `agent_started_at: string | null`。

崩溃一致性：进程重启后不可能还有 run 在跑（agent 是本进程的子进程），所以
`startScheduledTaskService()` 在启动 tick 之前先执行一次 `failInterruptedRuns(nowIso, 'server_restart')`，
否则残留的 `running` 行会把计数永久抬高（顺带修掉 run history 永远显示 Running… 的老问题）。
只在默认 scheduler 启动时做，`createScheduler()`（含其单元测试）行为不变；`startScheduledTaskService()`
因此从本轮起是 **async**（先 `await` 清理、再启动 tick，永不 reject；`server/index.js` 的调用点无需 await）。

### 14.2 Runner（`server/scheduled-tasks/runner.js`）

- 在真正发起 agent 调用之前调用 `db.markRunAgentStarted(run.id)`，best-effort：失败只 `console.warn`，绝不影响运行。
- 位置：provider 校验之后、`ensureProject` 之后、`query()` 之前；dry-run 分支在
  `finishOnce(... 'success')` 之前标记（§4 的 dry-run 只替换 agent 调用，语义上 agent 已启动，
  验收脚本依赖这一点）。
- 门控 skip / 门控 error / 参数错误 / provider 不支持 / `commands_disabled` 路径**绝不**调用它。

### 14.3 REST（`/api/scheduled-tasks`，沿用 router 现有鉴权）

| Method | Path | Response |
|---|---|---|
| GET | `/running` | `{ count: number }` |

- 注册在 `GET /:id` **之前**（同 `/presets`，否则 `running` 会被当成 task id）。
- `count = countRunningAgentRuns()`：agent 已启动且 run 仍在跑的**任务**数（DISTINCT `task_id`；
  一个任务同时最多一条 run）。计数是全局的，不按 user 过滤（scheduler 只有一个，任何用户都能看到它）。
- 走 `management.countRunningTasks()`（`{ ok: true, count }`）保证 REST 与其它调用方共用同一视图层。
- Run JSON 增加 `agentStartedAt`（camelCase，`runRowToJson`）。

### 14.4 Frontend

- `types.ts`: `ScheduledTaskRun.agentStartedAt: string | null`。
- `api.ts`: `runningCount(): Promise<number>` → `GET /api/scheduled-tasks/running` → `data.count`（缺省 0）。
- 新 hook `useRunningScheduledTasks({ intervalMs = 10000 })`：轮询该接口，返回 `{ count, refresh }`；
  `document.hidden` 时跳过请求、`visibilitychange` 回到可见时立即刷新；丢弃过期响应；请求失败保留上一次的值。
- `ScheduledTasksLauncher`（侧栏 footer 常驻入口）：`count > 0` 时在桌面与移动两个按钮上显示数字徽标
  （aria-label 用 i18n 复数），并把 `runningCount` 传给 `ScheduledTasksPanel`。
- `ScheduledTasksPanel` 头部标题旁显示同一计数徽标（`count > 0` 时）。
- `RunHistory`：`status === 'running'` 且 `agentStartedAt == null` 时显示 `t('runs.gatePhase')`
  （脚本门控中），否则保持现在的 `t('runs.inProgress')`。
- i18n（`en` + `zh-CN`，其余 locale 回退 en）：`launcher.running_one/other`、`runs.gatePhase`。

### 14.5 Write scopes (one owner per file)

| Owner | Files |
|---|---|
| backend | `server/modules/database/schema.ts`, `migrations.ts`, `repositories/scheduled-tasks.db.ts` (+test), `server/scheduled-tasks/runner.js` (+test), `service.js` (+test), `management.js` (+test), `server/routes/scheduled-tasks.js` (+test) |
| frontend | `src/components/scheduled-tasks/**`, `src/i18n/locales/{en,zh-CN}/scheduledTasks.json` |
| verify | `scripts/verify-scheduled-tasks-running-count.mjs` |
| lead | `docs/scheduled-tasks.md` |

### 14.6 Acceptance

- `npx vitest run`：除 main 上**既有**的 2 个 copilot 失败（`server/copilot-sdk.test.js` 的
  network-path 用例、`server/providers/copilot/adapter.test.js` 的 artifact-card 用例；本轮 base 的
  clean worktree 实测 2 failed / 791 passed，与本改动无关）外应全绿；外加 `npm run typecheck`、`npm run lint`。
- 单元测试覆盖：仓储层（列存在 / `markRunAgentStarted` 幂等 / `COUNT(DISTINCT task_id)` / 中断清理与幂等）、
  runner（门控执行期间与 skip 路径不标记、真正启动才标记一次、dry-run 标记、标记抛错不影响 run）、
  service（`reconcileInterrupted` 及其容错）、management（`countRunningTasks` / `agentStartedAt`）、
  route（`GET /running` 返回 count 且不遮蔽 `GET /:id`）、前端（hook 轮询与隐藏页暂停、徽标、RunHistory 门控文案）。
- `npx tsx --tsconfig server/tsconfig.json scripts/verify-scheduled-tasks-running-count.mjs`：
  - 门控脚本 sleep 期间 count（`management.countRunningTasks()`，即 `GET /running` 的同一视图）为 0（脚本在跑 ≠ agent 在跑）；
  - 门控 `{"skip":true}` 的 run 全程 count 为 0，且 `agent_started_at` 为 NULL；
  - 门控放行、注入的 fake query 挂起期间 count 为 1 且 `agentStartedAt` 非空，query resolve 后回 0；
  - `failInterruptedRuns` 收掉残留 `running` 行后计数归零。

## 15. Live running count over WebSocket（第十三轮）

§14 的徽标最初靠前端每 10s 轮询，最长有 10s 延迟。这一轮改成**服务端主动推送**：agent 启动或 run 结束的瞬间，
服务端就把新计数通过已有的 `/ws` 推给所有打开的页面；轮询退化为 15s 兜底（掉线 / 漏消息 / 刷新竞态时自愈）。

### 15.1 Event seam（`server/scheduled-tasks/events.js`，新文件）

```js
export function onScheduledTaskRunState(listener)   // -> unsubscribe；runner/service 不依赖 http/ws
export function emitScheduledTaskRunState(event)    // 永不抛：订阅者出错不影响 run
```

- 事件形状：`{ phase: 'agent_started' | 'finished', runId, taskId, status? }`。
- `markAgentStarted()`（含 dry-run 分支）之后发 `agent_started`；`finishOnce()` 对**任何**状态都发 `finished`
  （skip / error 也发：计数虽未变，但客户端可能错过了 `agent_started`）。门控阶段不会发 `agent_started`。

### 15.2 Broadcast（`server/index.js`）

- 启动时注册 `onScheduledTaskRunState(() => void broadcastScheduledTaskRunningCount())`。
- `broadcastScheduledTaskRunningCount()` 用 `getRunningTaskCount()`（`service.js` → `countRunningAgentRuns()`）
  只算一次，再向 `connectedClients` 发 `{ type: 'scheduled_task_running_count', count }`；客户端无需再请求。
- 计数/发送失败只记日志，绝不影响 run。

### 15.3 Frontend

- `useRunningScheduledTasks` 用 `useWebSocket().subscribeMessages` 订阅：收到 `scheduled_task_running_count`
  立即 `setCount`，同时让在途的轮询响应失效（request id 自增），避免旧值覆盖新推送。
- 兜底轮询 10s → **15s**；`visibilitychange` 与 `window.focus` 都会立刻补一次。
- 其余语义不变：`>0` 才显示徽标、失败保留上次值。

### 15.4 Write scopes

| Owner | Files |
|---|---|
| backend | `server/scheduled-tasks/events.js` (new), `runner.js` (+test), `service.js` (+test), `server/index.js` |
| frontend | `src/components/scheduled-tasks/hooks/useRunningScheduledTasks.ts` (+test) |
| verify | `scripts/verify-scheduled-tasks-running-count.mjs` |
| lead | `docs/scheduled-tasks.md` |

### 15.5 Acceptance

- `npx vitest run`（仅 base 上既有的 2 个 copilot 失败）、`npm run typecheck`、`eslint src/ server/`。
- `npx tsx --tsconfig server/tsconfig.json scripts/verify-scheduled-tasks-running-count.mjs` 新增两条：
  runner 在 agent 启动 / 结束时各发一次事件（顺序 `agent_started` → `finished`，计数 1 → 0），
  以及 skip 路径只发 `finished`（永不发 `agent_started`）。
- 端到端：重启服务后连 `ws://…/ws?token=…`，触发一次 run，客户端应秒级收到 `scheduled_task_running_count`。
