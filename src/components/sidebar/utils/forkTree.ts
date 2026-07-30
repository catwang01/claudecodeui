/**
 * Turn a flat list of sessions into a DFS-ordered fork tree.
 *
 * Ordering rule (subtree weight):
 *   weight(node) = max(node.lastActivity, max(weight(child)) for each child)
 *   = the newest leaf's timestamp anywhere under this node.
 *
 * Roots and each level of children are sorted by weight desc, so a subtree
 * whose leaf just gained a fresh fork bubbles to the top even if its root is
 * old. Collapsed nodes keep their own row but hide their descendants.
 *
 * A session whose parent isn't in the visible input becomes a depth-0 root.
 * Cycles (should never happen in practice) are broken by DFS visited-set.
 */

export type SessionLike = {
  id: string;
  forkParentId?: string | null;
  lastActivity?: string | Date | number | null;
  createdAt?: string | Date | number | null;
  // Any other fields — this shape is intentionally minimal.
  [k: string]: any;
};

export type ForkTreeNode<T extends SessionLike> = {
  session: T;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
};

function getTime(s: SessionLike): number {
  const raw = (s.lastActivity ?? s.createdAt ?? '') as string | number | Date;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw as string).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function buildForkTree<T extends SessionLike>(
  sessions: readonly T[],
  opts: { collapsedIds?: ReadonlySet<string>; enabled?: boolean } = {},
): ForkTreeNode<T>[] {
  const collapsedIds = opts.collapsedIds ?? new Set<string>();
  const enabled = opts.enabled ?? true;

  // Disabled → keep every row at depth 0 in original order.
  if (!enabled || sessions.length === 0) {
    return sessions.map((s) => ({ session: s, depth: 0, hasChildren: false, isCollapsed: false }));
  }

  const byId = new Map<string, T>();
  for (const s of sessions) byId.set(s.id, s);

  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of sessions) {
    const parentId = s.forkParentId || null;
    if (parentId && parentId !== s.id && byId.has(parentId)) {
      const list = childrenOf.get(parentId);
      if (list) list.push(s);
      else childrenOf.set(parentId, [s]);
    } else {
      roots.push(s);
    }
  }

  const weightCache = new Map<string, number>();
  const computeWeight = (s: T, guard: Set<string>): number => {
    const id = s.id;
    const cached = weightCache.get(id);
    if (cached !== undefined) return cached;
    if (guard.has(id)) return getTime(s);
    guard.add(id);
    let w = getTime(s);
    const kids = childrenOf.get(id);
    if (kids) for (const kid of kids) w = Math.max(w, computeWeight(kid, guard));
    guard.delete(id);
    weightCache.set(id, w);
    return w;
  };
  for (const s of sessions) computeWeight(s, new Set());

  const byWeightDesc = (a: T, b: T) =>
    (weightCache.get(b.id) ?? 0) - (weightCache.get(a.id) ?? 0);
  roots.sort(byWeightDesc);

  const out: ForkTreeNode<T>[] = [];
  const visited = new Set<string>();
  const walk = (s: T, depth: number) => {
    const id = s.id;
    if (visited.has(id)) return;
    visited.add(id);
    const kids = childrenOf.get(id);
    const hasChildren = !!kids && kids.length > 0;
    const isCollapsed = hasChildren && collapsedIds.has(id);
    out.push({ session: s, depth, hasChildren, isCollapsed });
    if (hasChildren && !isCollapsed) {
      const sorted = [...kids!].sort(byWeightDesc);
      for (const kid of sorted) walk(kid, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);

  // Safety net: cycles / orphans not reached — append at depth 0.
  for (const s of sessions) {
    if (!visited.has(s.id)) out.push({ session: s, depth: 0, hasChildren: false, isCollapsed: false });
  }
  return out;
}
