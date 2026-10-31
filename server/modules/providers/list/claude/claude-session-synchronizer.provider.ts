import path from 'path';
import os from 'os';
import { readFileTimestamps, readFirstJsonlLine, findFilesModifiedAfter } from '../../utils.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import { userDb, userSettingsDb } from '../../../../database/db.js';
import type { ISessionSynchronizer } from '../../types.js';
import { matchesExcludePattern } from '../../../../../shared/excludePatterns.js';

export { matchesExcludePattern };

const CLAUDE_HOME = path.join(os.homedir(), '.claude');

/**
 * Claude Code stores subagent transcripts at
 * `<project-dir>/<sessionId>/subagents/agent-<id>.jsonl` (and `agent-<id>.meta.json`).
 *
 * Those files are not project sessions:
 *   - `path.dirname()` is the `subagents` folder, so deriving the project's
 *     claude dir name from them yields the bogus name `subagents`. That value is
 *     persisted to `projects.claude_dir_name` and later makes every message
 *     lookup read `~/.claude/projects/subagents/<sessionId>.jsonl`, returning an
 *     empty history (and clobbering `sessions.jsonl_path` with the agent file).
 *   - their `sessionId` belongs to the parent session, not to a new one.
 *
 * The batch scan already skipped them; this predicate also guards the file
 * watcher, which calls `synchronizeFile()` directly for every .jsonl/.json.
 */
function isSubagentTranscript(filePath: string): boolean {
  // Location check: anything under <project-dir>/<sessionId>/subagents/ is a
  // subagent transcript, whatever it is named (agent-<id>.jsonl / .meta.json).
  // No project directory can be named exactly `subagents`: an encoded project
  // name always keeps its leading path segments (e.g. `-Users-x-subagents`).
  if (path.basename(path.dirname(filePath)) === 'subagents') return true;
  // Name check: keeps the original convention for transcripts found elsewhere.
  return path.basename(filePath).startsWith('agent-');
}

/**
 * Reads project exclude patterns from the first user's settings.
 * Stored in user_settings under key 'claude-settings' as JSON
 * { projectExcludePatterns: string[] }.
 */
function getServerExcludePatterns(): string[] {
  try {
    const firstUser = (userDb as any).getFirstUser?.();
    if (!firstUser) return [];
    const raw = (userSettingsDb as any).get?.(firstUser.id, 'claude-settings');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { projectExcludePatterns?: string[] };
    return Array.isArray(parsed?.projectExcludePatterns) ? parsed.projectExcludePatterns : [];
  } catch {
    return [];
  }
}

export const claudeSessionSynchronizer: ISessionSynchronizer = {
  provider: 'claude',

  watchPaths: [path.join(CLAUDE_HOME, 'projects')],

  async synchronize(since: Date | null): Promise<number> {
    const projectsDir = this.watchPaths[0];
    let files: string[];
    try {
      files = await findFilesModifiedAfter(projectsDir, '.jsonl', since);
    } catch {
      return 0;
    }

    let count = 0;
    for (const filePath of files) {
      if (isSubagentTranscript(filePath)) continue;
      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) count++;
    }
    return count;
  },

  async synchronizeFile(filePath: string): Promise<string | null> {
    // Subagent transcripts must never be treated as project sessions.
    // Guarding here (not only in synchronize()) also covers direct calls from
    // the sessions file watcher.
    if (isSubagentTranscript(filePath)) return null;

    const parsed = await readFirstJsonlLine(filePath, (data) => {
      const d = data as Record<string, unknown>;
      const sessionId = typeof d.sessionId === 'string' ? d.sessionId : null;
      const projectPath = typeof d.cwd === 'string' ? d.cwd : null;
      // Continue reading lines until we find both sessionId AND cwd
      // (first line might be queue-operation without cwd)
      if (!sessionId || !projectPath) return null;
      return { sessionId, projectPath };
    });

    if (!parsed) return null;

    // Skip if the decoded project path matches a user-configured exclude pattern.
    if (matchesExcludePattern(parsed.projectPath, getServerExcludePatterns())) return null;

    const timestamps = await readFileTimestamps(filePath).catch(() => ({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const claudeDirName = path.basename(path.dirname(filePath));

    projectsDb.createProjectPath(parsed.projectPath);
    projectsDb.updateClaudeDirName(parsed.projectPath, claudeDirName);

    sessionsDb.createSession(
      parsed.sessionId,
      'claude',
      parsed.projectPath,
      undefined,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    return parsed.sessionId;
  },
};
