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

