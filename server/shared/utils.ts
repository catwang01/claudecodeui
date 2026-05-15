import path from 'node:path';

export function normalizeProjectPath(projectPath: string): string {
  if (!projectPath) return projectPath;
  if (projectPath.startsWith('~/')) {
    return path.join(process.env.HOME || process.env.USERPROFILE || '~', projectPath.slice(2));
  }
  return path.resolve(projectPath);
}
