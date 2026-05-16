import path from 'path';
import os from 'os';
import { readFileTimestamps, findFilesModifiedAfter } from '../../utils.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import type { ISessionSynchronizer } from '../../types.js';

const CODEX_HOME = path.join(os.homedir(), '.codex');

export const codexSessionSynchronizer: ISessionSynchronizer = {
  provider: 'codex',

  watchPaths: [path.join(CODEX_HOME, 'sessions')],

  async synchronize(since: Date | null): Promise<number> {
    const sessionsDir = this.watchPaths[0];
    let files: string[];
    try {
      files = await findFilesModifiedAfter(sessionsDir, '.jsonl', since);
    } catch {
      return 0;
    }

    let count = 0;
    for (const filePath of files) {
      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) count++;
    }
    return count;
  },

  async synchronizeFile(filePath: string): Promise<string | null> {
    const sessionId = path.basename(path.dirname(filePath)) || path.basename(filePath, '.jsonl');
    if (!sessionId) return null;

    const timestamps = await readFileTimestamps(filePath).catch(() => ({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const projectPath = path.dirname(path.dirname(filePath));

    projectsDb.createProjectPath(projectPath);
    sessionsDb.createSession(
      sessionId,
      'codex',
      projectPath,
      undefined,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    return sessionId;
  },
};
