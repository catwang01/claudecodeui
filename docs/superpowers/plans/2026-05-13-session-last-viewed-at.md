# Session Last-Viewed-At Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `last_viewed_at` 时间戳替换布尔 `isRead`，使 "未读" 语义正确：`isRead = (lastViewedAt >= session.lastActivity)`，新消息到达后 session 自动变回未读。

**Architecture:** 后端 `markSessionRead()` 存储 JS 时间戳（修复 SQLite CURRENT_TIMESTAMP UTC bug）；`applyReadState()` 做时间戳比较而非布尔检查；前端 `Sidebar.tsx` 在 projects 更新时将服务端 `isRead=false` 的 session 从本地乐观缓存 `readSessionIds` 中移除。

**Tech Stack:** Node.js/better-sqlite3, React/TypeScript, WebSocket

---

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `server/database/db.js` | 修改 | `markSessionRead` 接收 `viewedAt` 参数；`getReadSessionIds` → `getReadStateMap` 返回 Map |
| `server/index.js` | 修改 | WS handler 从消息中取 `viewedAt`，传入 `markSessionRead` |
| `src/components/sidebar/view/Sidebar.tsx` | 修改 | WS 消息加 `viewedAt`；useEffect 同步服务端 isRead 到本地 readSessionIds |

---

### Task 1: DB — `markSessionRead` 接收 JS 时间戳

**Files:**
- Modify: `server/database/db.js`（`markSessionRead` 和 `getReadSessionIds` 函数，约第 712-727 行）

- [ ] **Step 1: 修改 `markSessionRead` 接收 `viewedAt` 参数**

在 `server/database/db.js` 中，找到 `markSessionRead`:

```javascript
// 原代码（约第 712-718 行）
markSessionRead: (sessionId, provider) => {
    db.prepare(`
      INSERT INTO session_read_state (session_id, provider)
      VALUES (?, ?)
      ON CONFLICT(session_id, provider) DO UPDATE SET read_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider || 'claude');
},
```

改为：

```javascript
markSessionRead: (sessionId, provider, viewedAt) => {
    const ts = viewedAt || new Date().toISOString();
    db.prepare(`
      INSERT INTO session_read_state (session_id, provider, read_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider) DO UPDATE SET read_at = excluded.read_at
    `).run(sessionId, provider || 'claude', ts);
},
```

- [ ] **Step 2: 将 `getReadSessionIds` 改为 `getReadStateMap`，返回 `Map<sessionId, readAt>`**

在 `server/database/db.js` 中，找到 `getReadSessionIds`（约第 720-727 行）：

```javascript
// 原代码
getReadSessionIds: (sessionIds, provider) => {
    if (!sessionIds.length) return new Set();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id FROM session_read_state WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider || 'claude');
    return new Set(rows.map(r => r.session_id));
},
```

改为：

```javascript
getReadStateMap: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, read_at FROM session_read_state WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider || 'claude');
    return new Map(rows.map(r => [r.session_id, r.read_at]));
},
```

- [ ] **Step 3: 修改 `applyReadState` 使用时间戳比较**

在 `server/database/db.js` 中，找到 `applyReadState`（约第 801-816 行）：

```javascript
// 原代码
function applyReadState(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const readIds = sessionDb.getReadSessionIds(ids, provider);
    if (!readIds.size) return;
    for (const session of sessions) {
      if (readIds.has(session.id)) {
        session.isRead = true;
      }
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply read state for ${provider}:`, error.message);
  }
}
```

改为：

```javascript
function applyReadState(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const readStateMap = sessionDb.getReadStateMap(ids, provider);
    if (!readStateMap.size) return;
    for (const session of sessions) {
      const readAt = readStateMap.get(session.id);
      if (readAt) {
        const readTime = new Date(readAt);
        const lastActivity = session.lastActivity instanceof Date
          ? session.lastActivity
          : new Date(session.lastActivity);
        session.isRead = readTime >= lastActivity;
      }
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply read state for ${provider}:`, error.message);
  }
}
```

- [ ] **Step 4: 验证无其他调用点**

```bash
grep -n "getReadSessionIds" /Users/tanhuan/claudecodeui/server/database/db.js
grep -rn "getReadSessionIds" /Users/tanhuan/claudecodeui/server/
```

预期：除了刚改的 `applyReadState` 之外，没有其他调用点。

- [ ] **Step 5: Commit**

```bash
cd /Users/tanhuan/claudecodeui
git add server/database/db.js
git commit -m "fix: session read state uses last-viewed-at timestamp comparison"
```

---

### Task 2: WS Handler — 传递 `viewedAt` 给 `markSessionRead`

**Files:**
- Modify: `server/index.js`（`mark_session_read` handler，约第 1920-1925 行）

- [ ] **Step 1: 修改 WS handler 从消息取 `viewedAt` 并传入**

在 `server/index.js` 中，找到：

```javascript
} else if (data.type === 'mark_session_read') {
    const { sessionId, provider } = data;
    if (sessionId) {
        sessionDb.markSessionRead(sessionId, provider || 'claude');
    }
}
```

改为：

```javascript
} else if (data.type === 'mark_session_read') {
    const { sessionId, provider, viewedAt } = data;
    if (sessionId) {
        sessionDb.markSessionRead(sessionId, provider || 'claude', viewedAt);
    }
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/tanhuan/claudecodeui
git add server/index.js
git commit -m "fix: pass viewedAt timestamp in mark_session_read WS handler"
```

---

### Task 3: 前端 — 发送 `viewedAt` 并同步服务端 `isRead` 到本地缓存

**Files:**
- Modify: `src/components/sidebar/view/Sidebar.tsx`（约第 54 行 state 声明、第 178-185 行 onSessionSelect、新增 useEffect）

- [ ] **Step 1: WS 消息加入 `viewedAt`**

在 `Sidebar.tsx` 中，找到 `onSessionSelect`（约第 178-185 行）：

```typescript
onSessionSelect: (session, projectName) => {
  if (session.id) {
    const provider = session.__provider || 'claude';
    sendMessage({ type: 'mark_session_read', sessionId: session.id, provider });
    setReadSessionIds(prev => { const next = new Set(prev); next.add(session.id); return next; });
  }
  handleSessionClick(session, projectName);
},
```

改为：

```typescript
onSessionSelect: (session, projectName) => {
  if (session.id) {
    const provider = session.__provider || 'claude';
    sendMessage({ type: 'mark_session_read', sessionId: session.id, provider, viewedAt: new Date().toISOString() });
    setReadSessionIds(prev => { const next = new Set(prev); next.add(session.id); return next; });
  }
  handleSessionClick(session, projectName);
},
```

- [ ] **Step 2: 新增 useEffect — 当 projects 更新时，从 `readSessionIds` 移除服务端已标为未读的 session**

在 `Sidebar.tsx` 中，找到 `readSessionIds` 的 `useState` 声明（约第 54 行），在其下方（或在其他 useEffect 附近）新增：

首先在文件顶部确认 `projects` prop/state 的变量名（通常从 `useProjectsState` 或 props 获取）。然后在 `readSessionIds` 声明后加：

```typescript
// When server sends updated project data, if a session is now unread (isRead=false),
// remove it from the local optimistic cache so the UI reflects the server state.
useEffect(() => {
  if (!projects?.length) return;
  setReadSessionIds(prev => {
    let changed = false;
    const next = new Set(prev);
    for (const project of projects) {
      const allSessions = [
        ...(project.sessions || []),
        ...(project.cursorSessions || []),
        ...(project.codexSessions || []),
        ...(project.geminiSessions || []),
      ];
      for (const session of allSessions) {
        if (session.id && session.isRead === false && next.has(session.id)) {
          next.delete(session.id);
          changed = true;
        }
      }
    }
    return changed ? next : prev;
  });
}, [projects]);
```

注意：`projects` 变量需对应 `Sidebar.tsx` 中实际使用的变量名。用以下命令确认：

```bash
grep -n "projects" /Users/tanhuan/claudecodeui/src/components/sidebar/view/Sidebar.tsx | head -30
```

- [ ] **Step 3: 确认类型定义 — `sendMessage` 接受 `viewedAt` 字段**

检查 `sendMessage` 的类型定义，确认可以传入额外字段（通常为 `Record<string, unknown>` 或泛型）：

```bash
grep -n "sendMessage\|type.*mark_session_read" /Users/tanhuan/claudecodeui/src/components/sidebar/view/Sidebar.tsx | head -10
grep -n "sendMessage" /Users/tanhuan/claudecodeui/src/hooks/useWebSocket.ts 2>/dev/null | head -10
```

如果 `sendMessage` 接受 `Record<string, unknown>`，不需要修改类型。否则找到类型定义文件，添加 `viewedAt?: string` 到 `mark_session_read` 消息类型。

- [ ] **Step 4: 启动开发服务器验证功能**

```bash
cd /Users/tanhuan/claudecodeui
# 后端
node server/index.js &
# 前端
npm run dev &
```

验证步骤：
1. 打开 `http://localhost:5174`，点击一个 session → 圆点变绿（已读）
2. 在该 session 对应的 JSONL 文件末尾追加一条新消息（或手动触发新消息）→ 圆点应变回蓝色（未读）
3. 刷新页面 → 曾点击过但无新消息的 session 应仍显示绿色；有新消息的 session 应显示蓝色

- [ ] **Step 5: Commit**

```bash
cd /Users/tanhuan/claudecodeui
git add src/components/sidebar/view/Sidebar.tsx
git commit -m "fix: send viewedAt timestamp and sync readSessionIds with server isRead state"
```

---

## Self-Review Checklist

- [x] **SQLite CURRENT_TIMESTAMP bug 修复**：`markSessionRead` 改用 `:viewed_at` 参数（JS 传入 ISO string），符合 memory 规则 "Never use SQLite CURRENT_TIMESTAMP"
- [x] **时间戳比较逻辑**：`isRead = (new Date(readAt) >= session.lastActivity)`
- [x] **前端乐观缓存同步**：`useEffect` on `projects` 更新时清除服务端标为未读的 session
- [x] **viewedAt 传递链路完整**：前端 → WS 消息 → server handler → `markSessionRead(viewedAt)` → DB
- [x] **无 placeholder**：每个步骤都有具体代码
- [x] **类型名一致**：`getReadStateMap` 在 Task 1 定义，在 `applyReadState` 中调用
