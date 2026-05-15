import { randomUUID } from 'node:crypto';
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

export const projectsDb = {
  createProjectPath(projectPath: string, customProjectName: string | null = null): CreateProjectPathResult {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
    const attemptedId = randomUUID();
    const row = db.prepare(`
      INSERT INTO projects (project_id, project_path, custom_project_name, isArchived)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(project_path) DO UPDATE SET isArchived = 0 WHERE projects.isArchived = 1
      RETURNING project_id, project_path, custom_project_name, isStarred, isArchived
    `).get(attemptedId, normalizedProjectPath, normalizedProjectName) as ProjectRepositoryRow | undefined;

    if (row) {
      return { outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived', project: row };
    }
    const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
    return { outcome: 'active_conflict', project: existingProject };
  },

  getProjectPath(projectPath: string): ProjectRepositoryRow | null {
    const db = getConnection();
    const normalized = normalizeProjectPath(projectPath);
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects WHERE project_path = ?'
    ).get(normalized) as ProjectRepositoryRow | null ?? null;
  },

  getProjectById(projectId: string): ProjectRepositoryRow | null {
    const db = getConnection();
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects WHERE project_id = ?'
    ).get(projectId) as ProjectRepositoryRow | null ?? null;
  },

  getProjectPathById(projectId: string): string | null {
    const row = projectsDb.getProjectById(projectId);
    return row?.project_path ?? null;
  },

  getAllProjects(): ProjectRepositoryRow[] {
    const db = getConnection();
    return db.prepare(
      'SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects WHERE isArchived = 0'
    ).all() as ProjectRepositoryRow[];
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

  archiveProject(projectPath: string): void {
    const db = getConnection();
    db.prepare('UPDATE projects SET isArchived = 1 WHERE project_path = ?')
      .run(normalizeProjectPath(projectPath));
  },

  deleteProject(projectPath: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM projects WHERE project_path = ?')
      .run(normalizeProjectPath(projectPath));
  },
};
