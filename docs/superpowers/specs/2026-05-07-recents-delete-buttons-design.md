# Recents: Add Two Delete Buttons

**Date:** 2026-05-07

## Goal

在 Recents 视图的每个 session item hover 时，并排显示两个操作按钮：
1. **Hide from recents** (`EyeOff` icon) — 将 session 从 Recents 隐藏（现有功能，换图标）
2. **Delete session** (`Trash2` icon) — 永久删除 session（触发现有确认弹窗）

## Current State

`SidebarSessionItem.tsx` recents variant (lines 99-106)：hover 时显示 **一个** Trash2 按钮，标题为 "Hide from recents"，调用 `onHideSession()`。

## Design

### UI Changes (`SidebarSessionItem.tsx`)

**Recents variant hover area** — 将单按钮改为两个并排按钮：

```
[session name ...]  [EyeOff]  [Trash2]
                   ↑          ↑
             "Hide from    "Delete session"
              recents"      (→ confirmation modal)
```

- 两按钮均在 `group-hover:flex`，默认 `hidden`
- EyeOff 按钮：`hover:text-muted-foreground`，调用 `onHideSession()`
- Trash2 按钮：`hover:text-red-500`，调用 `onDeleteSession(...)`

### Props Change (`RecentsProps`)

添加：
```typescript
onDeleteSession: (
  projectName: string,
  sessionId: string,
  sessionTitle: string,
  provider: SessionProvider
) => void;
```

### Wiring (`SidebarContent.tsx`)

在 recents 渲染的 `<SidebarSessionItem>` 上添加：
```typescript
onDeleteSession={projectListProps.onDeleteSession}
```

`projectListProps.onDeleteSession` 已存在，指向 `useSidebarController` 的 `showDeleteSessionConfirmation`，会弹出现有确认 modal（`SidebarModals.tsx`）。

## Data Flow

```
用户点击 Trash2
  → SidebarSessionItem.onDeleteSession(project.name, session.id, sessionView.sessionName, session.__provider)
  → SidebarContent: projectListProps.onDeleteSession (透传)
  → useSidebarController: showDeleteSessionConfirmation (设置 sessionDeleteConfirmation state)
  → SidebarModals 弹出 "Delete session?" 确认弹窗
  → 用户确认 → useSidebarController.confirmDeleteSession() → api.deleteSession()
```

## Files Changed

| File | Change |
|------|--------|
| `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx` | RecentsProps 加 `onDeleteSession`；换 EyeOff 图标；加 Trash2 按钮 |
| `src/components/sidebar/view/subcomponents/SidebarContent.tsx` | 传 `onDeleteSession={projectListProps.onDeleteSession}` |

## Out of Scope

- Default variant 不变
- 确认弹窗复用现有 SidebarModals，不新建组件
- i18n 字符串：button title 直接用英文（与现有 "Hide from recents" 风格一致）
