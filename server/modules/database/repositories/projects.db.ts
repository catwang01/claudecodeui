import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) return trimmedCustomName;
  const directoryName = path.basename(projectPath);
  return directoryName || projectPath;
}

/**
 * Realpath that also canonicalizes the on-disk *casing* on case-insensitive volumes
 * (macOS APFS). fs.realpathSync() keeps the caller's casing, so /Users/x/Proj and
 * /users/x/proj would stay different strings even though they are the same directory.
 * fs.realpathSync.native() calls realpath(3) and returns the stored names; on a
 * case-sensitive volume two genuinely distinct paths stay distinct, so this never merges
 * unrelated directories.
 */
function canonicalRealpath(target: string): string {
  if (typeof fs.realpathSync.native === 'function') return fs.realpathSync.native(target);
  return fs.realpathSync(target);
}

/**
 * Canonical form of a project path, used for every alias comparison in this module.
 *
 * macOS exposes the same directory under two spellings (/var/... vs /private/var/...,
 * /tmp vs /private/tmp), symlinks, and case variants; project rows may store any of them.
 * canonicalRealpath() collapses those aliases. When the path (or an ancestor) no longer
 * exists — a deleted project directory — we canonicalize the nearest existing ancestor and
 * re-append the missing segments, so a deleted directory still compares equal to its alias
 * spellings.
 */
export function canonicalizeProjectPath(input: string): string {
  const resolved = normalizeProjectPath(input);
  if (!resolved) return resolved;

  try {
    return canonicalRealpath(resolved);
  } catch {
    // Fall through: at least one segment is gone (deleted dir / unmounted volume).
  }

  const tail: string[] = [];
  let current = resolved;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    tail.unshift(path.basename(current));
    current = parent;
    try {
      return path.join(canonicalRealpath(current), ...tail);
    } catch {
      /* keep walking up */
    }
  }
  return resolved;
}

/** True when `candidate` is `root` itself or lives underneath it (whole path segments). */
export function isPathSameOrInside(candidate: string, root: string): boolean {
  if (!candidate || !root) return false;
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}

export type CreateProjectPathOptions = {
  /**
   * Reactivate an existing archived row for the same path (set isArchived = 0).
   *
   * Only explicit user actions ("add project" / "create project") may opt in. The session
   * synchronizers must use the default (false): otherwise re-scanning a JSONL file for a
   * folder the user just deleted would resurrect the archived project row on the next sync
   * (issue #16). Archiving is intentionally sticky.
   */
  reactivateArchived?: boolean;
};

export const projectsDb = {
  createProjectPath(
    projectPath: string,
    customProjectName: string | null = null,
    options: CreateProjectPathOptions = {}
  ): CreateProjectPathResult {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
    const attemptedId = randomUUID();
    // Default conflict behaviour is DO NOTHING: an archived row stays archived even when the
    // synchronizer re-discovers the project's session files. Passing reactivateArchived
    // restores the legacy "revive on explicit re-add" behaviour.
    const conflictClause = options.reactivateArchived
      ? 'ON CONFLICT(project_path) DO UPDATE SET isArchived = 0 WHERE projects.isArchived = 1'
      : 'ON CONFLICT(project_path) DO NOTHING';
    const row = db.prepare(`
      INSERT INTO projects (project_id, project_path, custom_project_name, isArchived)
      VALUES (?, ?, ?, 0)
      ${conflictClause}
      RETURNING project_id, project_path, custom_project_name, isStarred, isArchived
    `).get(attemptedId, normalizedProjectPath, normalizedProjectName) as ProjectRepositoryRow | undefined;

    if (row) {
      return { outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived', project: row };
    }
    const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
    if (existingProject?.isArchived) {
      return { outcome: 'archived_conflict', project: existingProject };
    }
    return { outcome: 'active_conflict', project: existingProject };
  },

  getProjectPath(projectPath: string): ProjectRepositoryRow | null {
    const db = getConnection();
    const normalized = normalizeProjectPath(projectPath);
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, claude_dir_name, isStarred, isArchived FROM projects WHERE project_path = ?'
    ).get(normalized) as ProjectRepositoryRow | null ?? null;
  },

  getProjectById(projectId: string): ProjectRepositoryRow | null {
    const db = getConnection();
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, claude_dir_name, isStarred, isArchived FROM projects WHERE project_id = ?'
    ).get(projectId) as ProjectRepositoryRow | null ?? null;
  },

  getProjectPathById(projectId: string): string | null {
    const row = projectsDb.getProjectById(projectId);
    return row?.project_path ?? null;
  },

  getAllProjects(): ProjectRepositoryRow[] {
    const db = getConnection();
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, claude_dir_name, isStarred, isArchived FROM projects WHERE isArchived = 0'
    ).all() as ProjectRepositoryRow[];
  },

  /** Every project row, archived included — used to resolve a project by its API name/idempotency checks. */
  getAllProjectRows(): ProjectRepositoryRow[] {
    const db = getConnection();
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, claude_dir_name, isStarred, isArchived FROM projects'
    ).all() as ProjectRepositoryRow[];
  },

  getProjectByClaudeDirName(claudeDirName: string): ProjectRepositoryRow | null {
    const db = getConnection();
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, claude_dir_name, isStarred, isArchived FROM projects WHERE claude_dir_name = ?'
    ).get(claudeDirName) as ProjectRepositoryRow | null ?? null;
  },

  updateProjectStar(projectPath: string, isStarred: boolean): void {
    const db = getConnection();
    db.prepare('UPDATE projects SET isStarred = ? WHERE project_path = ?')
      .run(isStarred ? 1 : 0, normalizeProjectPath(projectPath));
  },

  updateProjectCustomName(projectPath: string, customName: string | null): void {
    const db = getConnection();
    db.prepare('UPDATE projects SET custom_project_name = ? WHERE project_path = ?')
      .run(customName, normalizeProjectPath(projectPath));
  },

  updateClaudeDirName(projectPath: string, claudeDirName: string): void {
    const db = getConnection();
    db.prepare(
      'UPDATE projects SET claude_dir_name = ? WHERE project_path = ?'
    ).run(claudeDirName, normalizeProjectPath(projectPath));
  },

  /** Archive one project. Returns the number of rows changed (0 when already archived or unknown). */
  archiveProject(projectPath: string): number {
    const db = getConnection();
    const result = db.prepare('UPDATE projects SET isArchived = 1 WHERE project_path = ? AND isArchived = 0')
      .run(normalizeProjectPath(projectPath));
    return result.changes;
  },

  /**
   * Archive every active project rooted at `rootPath` or inside it.
   *
   * Used when the file tree deletes a directory: the directory (and any project rooted at it)
   * can no longer be opened, so the row must be archived right away instead of surviving until
   * the next session sync (issue #16). Returns the archived project paths.
   */
  archiveProjectsUnderPath(rootPath: string): string[] {
    const db = getConnection();
    const canonicalRoot = canonicalizeProjectPath(rootPath);
    // Compare canonical (realpath) forms, not raw strings: a row stored as /var/... must be
    // archived when the file tree deleted /private/var/... (issue #16 verifier F1).
    const rows = db.prepare('SELECT project_path FROM projects WHERE isArchived = 0').all() as Array<{ project_path: string }>;
    const targets = rows
      .map((row) => row.project_path)
      .filter((candidate) => isPathSameOrInside(canonicalizeProjectPath(candidate), canonicalRoot));
    if (targets.length === 0) return [];

    const update = db.prepare('UPDATE projects SET isArchived = 1 WHERE project_path = ? AND isArchived = 0');
    const archiveAll = db.transaction((paths: string[]) => {
      for (const candidate of paths) update.run(candidate);
    });
    archiveAll(targets);
    return targets;
  },

  /**
   * Archive every active row that canonicalizes to the *same* directory as `projectPath`
   * (all alias spellings, e.g. /var/... and /private/var/...). Used by the archive-by-name
   * endpoint so a removed project cannot linger in the list under another spelling.
   * Idempotent. Returns the archived paths.
   */
  archiveProjectAliases(projectPath: string): string[] {
    const db = getConnection();
    const canonical = canonicalizeProjectPath(projectPath);
    const rows = db.prepare('SELECT project_path FROM projects WHERE isArchived = 0').all() as Array<{ project_path: string }>;
    const targets = rows
      .map((row) => row.project_path)
      .filter((candidate) => canonicalizeProjectPath(candidate) === canonical);
    if (targets.length === 0) return [];

    const update = db.prepare('UPDATE projects SET isArchived = 1 WHERE project_path = ? AND isArchived = 0');
    const archiveAll = db.transaction((paths: string[]) => {
      for (const candidate of paths) update.run(candidate);
    });
    archiveAll(targets);
    return targets;
  },

  deleteProject(projectPath: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM projects WHERE project_path = ?')
      .run(normalizeProjectPath(projectPath));
  },
};
