# 项目目录可用性与“移除（归档）”

> 对应 issue #16：删除项目目录后，侧边栏仍把它当作项目识别，点进去文件树接口 404。
> 实现范围：`server/projects.js`、`server/index.js`、
> `server/modules/database/repositories/projects.db.ts`、`src/components/sidebar/**`。

## 1. 可用性判定规则

项目列表（`GET /api/projects`）和每个项目对象新增 `availability` 字段：

```jsonc
{
  "name": "-Users-edward-MyFolder-demo",
  "path": "/Users/edward/MyFolder/demo",
  "availability": {
    "status": "available",   // 'available' | 'missing'
    "available": true,       // 仅 status === 'missing' 时为 false
    "readable": true,        // stat 成功 / 无法验证时为 false 或 null
    "reason": null,          // 见下表
    "errorCode": null        // 原始 errno，例如 'ENOENT' / 'EACCES'
  }
}
```

判定在每次项目列表重建时现场 `stat`（`getProjectPathAvailability`），只有**确定不存在**的错误才算缺失：

| 情况 | status | available | readable | reason | 行为 |
| --- | --- | --- | --- | --- | --- |
| 目录存在且可访问 | `available` | `true` | `true` | `null` | 正常进入 |
| `ENOENT`（含外接盘挂载点消失） | `missing` | `false` | `false` | `not_found` | 置灰、禁止进入/展开，提供“移除（归档）” |
| `ENOTDIR` / 路径是普通文件 | `missing` | `false` | `false` | `not_a_directory` | 同上 |
| 空路径 | `missing` | `false` | `false` | `empty_path` | 同上 |
| `EACCES` / `EPERM` | `available` | `true` | `false` | `permission_denied` | **仍可进入**，只显示警告提示 |
| `EIO` / `EBUSY` / `ENOTCONN` / `EMFILE` 等 | `available` | `true` | `false` | `check_failed` | 仍可进入 |
| stat 超时（默认 1.5s） | `available` | `true` | `false` | `check_timeout` | 仍可进入 |

关键约束：**除 `ENOENT`/`ENOTDIR` 外，任何 stat 失败都不会让项目被隐藏、归档或删除。**
外接盘未挂载、权限异常、I/O 抖动都只会让 `readable=false` + 一个 `reason`，项目仍在列表里。

文件树接口 `GET /api/projects/:name/files` 的错误码：

- 目录缺失：`404` + `code: "PROJECT_PATH_MISSING"`（附带 `availability`）。
- 目录不可读（`EACCES`/`EPERM`）：`403` + `code: "PROJECT_PATH_UNREADABLE"`（附带 `availability`）。
- 其他无法验证的情况：`503` + `code: "PROJECT_PATH_CHECK_FAILED"`。

文件树接口与 `POST /api/projects/create` 的响应同样带 `availability`（创建接口返回的
`project.availability` 与列表 payload 同形）。

## 2. 删除/归档后的缓存失效与 legacy 兜底

以下路径在成功后都会失效 `_cachedProjectsList` 与 `projectDirectoryCache`，并向所有 WebSocket
客户端推送新的 `projects_updated`：

- `DELETE /api/projects/:projectName`（删除项目）
- `DELETE /api/projects/:projectName/files`（文件树删除目录）：先归档与该目录匹配的项目行
  （`project_path === 删除路径` 或位于其下），再失效缓存并广播。
- `POST /api/projects/:projectName/archive`（仅归档，见下）

此外，watcher 的 `flushBroadcast` 快路径在广播缓存引用前会回查 DB：项目行已被归档/删除时
强制走全量重建，避免陈旧 `_cachedProjectsList` 把已删除项目重新广播出来（这是 issue #16
“另一条相关线索”的根因）。目录 `unlinkDir` 事件也会清空提取缓存并触发一次重建。

**legacy 兜底**：`_getProjectsImpl()` 原来在 `getAllProjects().length === 0`（不含 archived）时回退到
扫描 `~/.claude/projects/*` 的 `getProjectsLegacy()`。因为归档是非破坏性的（目录仍在），当用户把最后
一个活跃项目也归档后，该兜底会把所有已归档项目重新列出来（verifier 复现：`[a, b]` → archive b → `[a]`
→ archive a → 又出现 `[a, b]`）。修复：只有当 projects 表**一行都没有（含 archived）**时才使用 legacy
兜底；`getProjectsLegacy()` 另外按 realpath 剔除带 archived 行的路径作为双保险。

## 2.1 路径别名（/var vs /private/var）

macOS 上同一个目录可能以多种拼写存进数据库：`/var/...` 与 `/private/var/...`（`/tmp` 与
`/private/tmp`）、指向同一真实目录的符号链接，以及仅大小写不同的写法（不区分大小写的 APFS 卷）。
所有归档相关的路径比较都先经过 `canonicalizeProjectPath()`：用 `fs.realpathSync.native` 一次消解
符号链接、卷别名与卷上的实际大小写（普通 `fs.realpathSync` 会保留调用方给的大小写，`/Users/x/Proj`
与 `/users/x/proj` 会留下两个不同的 key）；路径已删除时退化为“最近存在祖先的 realpath + 缺失段”，
仍然保持多种拼写相等。大小写敏感卷上仅大小写不同的两个真实目录不会被误合并：

- `projectsDb.archiveProjectsUnderPath()`：删除目录时按 canonical 形式做包含判断，删
  `/private/var/.../child` 也能归档存成 `/var/.../child` 的项目行。
- `projectsDb.archiveProjectAliases()` / `archiveProjectByName()`：按同一个真实目录把**所有别名行**
  一起归档，幂等。
- `deleteProject()` 也改为归档全部别名（`archiveProjectAliases` 兜底单行 `archiveProject`）。

**同目录重复行的取舍**：我们选择“归档时归档所有别名行”，**不**在列表层按 realpath 去重。原因是
`sessions.project_path` 通过外键指向 `projects.project_path`，同一目录的会话可能按拼写分散在两行；
列表去重会静默隐藏其中一行的会话，风险高于收益。显式归档（以及删除项目）会清掉该目录的所有拼写，
因此“移除后不会以另一种拼写残留”；若历史脏数据里两行都活跃，UI 会显示两个条目，用户可逐个移除。
按 name 归档还有另一类天然歧义（不同真实目录编码成同一个 name），见 §2.2。

## 2.2 有损项目名的歧义（A4）

API 里的项目名是路径的**有损**编码：`/`、`:`、空格、`~`、`_` 都会变成 `-`，所以
`.../x_y` 与 `.../x/y` 会得到同一个 name。按 name 归档时绝不猜：

1. 先精确匹配 `claude_dir_name === name`，没有才退到“编码后的 `project_path`”；
2. 只有当**活跃**候选行只对应**唯一一个真实目录**（`canonicalizeProjectPath` 唯一）时，才做别名扩展并归档；
3. 若命中多个不同真实目录 → **不做任何归档**，返回 `409` + `code: PROJECT_NAME_AMBIGUOUS` +
   `candidatePaths`（fail-closed，便于排查）。

已归档的兄弟行不会造成歧义（歧义只按活跃行判定），重复调用保持幂等。

**API 约定变更**：`POST /api/projects/:projectName/archive` 现在接受可选 JSON 请求体
`{ "path": "/abs/project/dir" }`：

- **带 `path`**：按 `canonicalizeProjectPath(path)` 精确匹配，归档该真实目录的所有别名行。正常 UI
  流程走这一支：侧边栏“移除”按钮总是带 `project.path`，因此不会因 name 有损而误伤同名的另一个目录。
- **不带 `path` 且 name 命中多个真实目录**：`409` + `code: "PROJECT_NAME_AMBIGUOUS"` +
  `candidatePaths: string[]`，**不归档任何行**（fail-closed，便于排查）。
- **其余情况不变**：`200` + `{ success, archived, alreadyArchived, path, archivedPaths }`；未知项目
  `404 PROJECT_NOT_FOUND`。响应里的 `archivedPaths` 仍是实际被归档的 `project_path` 列表。
- 程序侧 `archiveProjectByName(projectName, { requestedPath })` 的返回值新增 `ambiguous: boolean` 与
  `candidatePaths: string[]`。

**规避方式**：内部调用优先按路径/别名操作（带 `path`，或直接使用 `project.path`），不要假设 name
唯一；只有确认某个 name 只对应一个真实目录时才可省略 `path`。name 冲突时列表里会看到两个同名条目，
需要按路径/availability 区分，不能只靠 name 做删除/归档。

## 3. 归档不回潮（sticky archive）

`archiveProject` 之后项目行的 `isArchived = 1`，同步器仍可能扫到该项目的历史 JSONL 文件并调用
`projectsDb.createProjectPath(projectPath)`。为避免“归档后又被同步器复活”：

- `createProjectPath()` 默认冲突策略是 `ON CONFLICT(project_path) DO NOTHING`：归档行保持归档，
  返回 outcome `archived_conflict`，**不修改 isArchived**。
- 只有显式用户操作（`addProjectManually` / “创建项目”）传
  `{ reactivateArchived: true }` 才允许把 `isArchived` 翻回 0。
- `flushBroadcast` 快路径回查 DB（见上），不会广播归档项目。

因此“归档”是粘性的：同步器反复扫描也不会让已移除的项目回到侧边栏；用户想恢复时重新
“添加项目”即可。

## 4. “移除（归档）”入口

对于 `availability.status === 'missing'` 的项目，侧边栏项目行会：

- 显示警告徽标（“目录不存在”/“路径不是目录”）并置灰；
- 阻止点击进入与展开（不会再去请求 `/files` 触发 404）；
- 展示 **移除** 按钮（`Archive` 图标）。

“移除”调用 `POST /api/projects/:projectName/archive`，语义是**非破坏性归档**（会归档同一真实目录的
所有别名行，响应里的 `archivedPaths` 列出实际归档的行）：

- 只把 `projects.isArchived` 置 1；
- 不删除 `~/.claude/projects/<name>` 下的会话文件；
- 不删除 `sessions` 表行；
- 幂等：已归档再调用返回 `200` + `alreadyArchived: true`；项目不存在返回 `404 PROJECT_NOT_FOUND`。

与“删除项目”（`DELETE /api/projects/:name`）不同，归档不会丢失会话历史，适合外接盘临时
未挂载等误判场景下让用户手动整理列表，之后重新添加项目即可恢复。
