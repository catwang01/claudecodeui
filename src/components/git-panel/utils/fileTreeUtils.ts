import type { FileStatusCode } from '../types/types';

export type FileTreeNode = {
  /** The display segment — dirname or filename. */
  name: string;
  /** Full relative path from repo root. For dirs this is the prefix path. */
  fullPath: string;
  isDir: boolean;
  /** Only set for leaf file nodes. */
  status?: FileStatusCode;
  children: FileTreeNode[];
};

/**
 * Build a directory tree from a flat list of changed files.
 * Returns an artificial root node whose `children` are the top-level entries.
 */
export function buildFileTree(
  files: Array<{ path: string; status: FileStatusCode }>,
): FileTreeNode {
  const root: FileTreeNode = { name: '', fullPath: '', isDir: true, children: [] };

  for (const { path, status } of files) {
    const parts = path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        // Leaf file node
        current.children.push({
          name: part,
          fullPath: path,
          isDir: false,
          status,
          children: [],
        });
      } else {
        // Directory node — find existing or create
        const dirPath = parts.slice(0, i + 1).join('/');
        let dir = current.children.find((c) => c.isDir && c.name === part);
        if (!dir) {
          dir = { name: part, fullPath: dirPath, isDir: true, children: [] };
          current.children.push(dir);
        }
        current = dir;
      }
    }
  }

  return root;
}

/** Return all leaf file `fullPath`s under a node (recursive). */
export function getAllLeafPaths(node: FileTreeNode): string[] {
  if (!node.isDir) return [node.fullPath];
  return node.children.flatMap(getAllLeafPaths);
}
