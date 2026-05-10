# Recents Delete Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Recents session item hover 时并排显示两个按钮：EyeOff（hide from recents）和 Trash2（delete session，触发现有确认 modal）。

**Architecture:** 改 `SidebarSessionItem.tsx` recents variant（换图标、加按钮、加 prop）；改 `SidebarContent.tsx` 透传现有的 `projectListProps.onDeleteSession`。确认弹窗由现有 `useSidebarController → SidebarModals` 处理，零新增逻辑。

**Tech Stack:** React, TypeScript, lucide-react (EyeOff, Trash2), Tailwind CSS

---

## File Map

| File | Change |
|------|--------|
| `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx` | RecentsProps 加 `onDeleteSession`；EyeOff 替换 Trash2（hide）；新增 Trash2 按钮（delete） |
| `src/components/sidebar/view/subcomponents/SidebarContent.tsx` | `<SidebarSessionItem>` 加 `onDeleteSession={projectListProps.onDeleteSession}` |

---

### Task 1: Update SidebarSessionItem — RecentsProps type + icons + new button

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx`

现状：
- `RecentsProps` 有 `onHideSession: () => void`，无 `onDeleteSession`
- recents variant 行 99-106：一个 `hidden group-hover:flex` Trash2 按钮，调用 `onHideSession()`

目标：
- `RecentsProps` 新增 `onDeleteSession` prop（与 `DefaultProps` 中签名一致）
- 解构时加入 `onDeleteSession`
- 将原 Trash2 按钮改为 EyeOff（hide），新增 Trash2（delete）

- [ ] **Step 1: 读取文件确认当前状态**

```bash
# 确认 RecentsProps 定义位置和现有 import
grep -n "EyeOff\|Trash2\|EyeSlash\|from 'lucide" src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx | head -20
```

Expected: 看到 `Trash2` import，无 `EyeOff`。

- [ ] **Step 2: 添加 EyeOff 到 import**

在文件顶部 lucide-react import 行，加入 `EyeOff`。

当前（约 line 1-5）：
```typescript
import { Folder, Sparkles, Trash2 } from 'lucide-react';
```
改为：
```typescript
import { EyeOff, Folder, Sparkles, Trash2 } from 'lucide-react';
```

- [ ] **Step 3: 在 RecentsProps 中添加 onDeleteSession**

找到 `type RecentsProps` 定义，在 `onHideSession: () => void;` 后面加：
```typescript
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider
  ) => void;
```

- [ ] **Step 4: 在 recents variant 解构中加入 onDeleteSession**

找到 `const { projectColorDot, projectDisplayName, onSessionSelect, onHideSession } = props;`（约 line 55），改为：
```typescript
const { projectColorDot, projectDisplayName, onSessionSelect, onHideSession, onDeleteSession } = props;
```

- [ ] **Step 5: 替换单按钮为两按钮**

找到 recents variant 中的 button 块（约 lines 99-106）：
```typescript
            <button
              className="ml-1 hidden group-hover:flex items-center justify-center h-4 w-4 rounded text-muted-foreground/40 hover:text-muted-foreground transition-colors flex-shrink-0"
              onClick={(e) => { e.stopPropagation(); onHideSession(); }}
              title="Hide from recents"
              type="button"
            >
              <Trash2 className="h-3 w-3" />
            </button>
```

替换为：
```typescript
            <button
              className="ml-1 hidden group-hover:flex items-center justify-center h-4 w-4 rounded text-muted-foreground/40 hover:text-muted-foreground transition-colors flex-shrink-0"
              onClick={(e) => { e.stopPropagation(); onHideSession(); }}
              title="Hide from recents"
              type="button"
            >
              <EyeOff className="h-3 w-3" />
            </button>
            <button
              className="hidden group-hover:flex items-center justify-center h-4 w-4 rounded text-muted-foreground/40 hover:text-red-500 transition-colors flex-shrink-0"
              onClick={(e) => { e.stopPropagation(); onDeleteSession(project.name, session.id, sessionView.sessionName, session.__provider); }}
              title="Delete session"
              type="button"
            >
              <Trash2 className="h-3 w-3" />
            </button>
```

- [ ] **Step 6: TypeScript check**

```bash
cd /Users/tanhuan/claudecodeui && npx tsc --noEmit 2>&1 | grep SidebarSessionItem
```

Expected: 无报错（或仅 SidebarContent 报告缺少 prop，Task 2 修复）。

---

### Task 2: Wire onDeleteSession in SidebarContent

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`

- [ ] **Step 1: 找到 recents variant 的 SidebarSessionItem 调用**

```bash
grep -n "onHideSession\|variant.*recents\|SidebarSessionItem" src/components/sidebar/view/subcomponents/SidebarContent.tsx
```

Expected: 约 line 278 处的 `<SidebarSessionItem variant="recents" ... onHideSession={...} />`

- [ ] **Step 2: 添加 onDeleteSession prop**

找到该 `<SidebarSessionItem>` 调用，在 `onHideSession={...}` 行之后插入：
```typescript
                onDeleteSession={projectListProps.onDeleteSession}
```

完整的 `<SidebarSessionItem>` 调用应类似：
```typescript
<SidebarSessionItem
  key={`${session.id}-${session.__provider}`}
  variant="recents"
  project={project}
  session={session}
  currentTime={projectListProps.currentTime}
  isProcessing={projectListProps.processingSessions?.has(session.id) ?? false}
  projectColorDot={color.dot}
  projectDisplayName={project.displayName || project.name}
  onSessionSelect={projectListProps.onSessionSelect}
  onHideSession={() => hideSession(session.id, session.__provider || 'claude', session.lastActivity || session.createdAt || '')}
  onDeleteSession={projectListProps.onDeleteSession}
  t={t}
/>
```

- [ ] **Step 3: TypeScript check（完整）**

```bash
cd /Users/tanhuan/claudecodeui && npx tsc --noEmit 2>&1 | grep -E "error|Error"
```

Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
cd /Users/tanhuan/claudecodeui
git add src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx
git add src/components/sidebar/view/subcomponents/SidebarContent.tsx
git commit -m "feat(recents): add hide + delete session buttons

Recents session item now shows two action buttons on hover:
- EyeOff: hide from recents (existing feature, icon changed)
- Trash2: delete session permanently (triggers existing confirm modal)"
```

---

## Self-Review

**Spec coverage:**
- [x] EyeOff (hide) + Trash2 (delete) 并排 — Task 1 Step 5
- [x] Hide 在左，Delete 在右 — Task 1 Step 5
- [x] Delete 触发确认弹窗 — 通过 `projectListProps.onDeleteSession → showDeleteSessionConfirmation`（现有流程，无需新增）
- [x] RecentsProps 扩展 — Task 1 Step 3
- [x] SidebarContent 透传 — Task 2 Step 2

**Placeholder scan:** 无 TBD/TODO。

**Type consistency:**
- `onDeleteSession` 签名在 Task 1 Step 3 定义，Task 2 Step 2 引用 `projectListProps.onDeleteSession`（`SidebarProjectListProps` 中已有相同签名）。一致。
