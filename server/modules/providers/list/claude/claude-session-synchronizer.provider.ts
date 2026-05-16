import path from 'path';
import os from 'os';
import { readFileTimestamps, readFirstJsonlLine, findFilesModifiedAfter } from '../../utils.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import type { ISessionSynchronizer } from '../../types.js';

const CLAUDE_HOME = path.join(os.homedir(), '.claude');

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
      if (path.basename(filePath).startsWith('agent-')) continue;
      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) count++;
    }
    return count;
  },

  async synchronizeFile(filePath: string): Promise<string | null> {
    const parsed = await readFirstJsonlLine(filePath, (data) => {
      const d = data as Record<string, unknown>;
      const sessionId = typeof d.sessionId === 'string' ? d.sessionId : null;
      const projectPath = typeof d.cwd === 'string' ? d.cwd : null;
      if (!sessionId || !projectPath) return null;
      return { sessionId, projectPath };
    });

    if (!parsed) return null;

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
