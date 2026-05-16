import path from 'path';
import os from 'os';
import { readFileTimestamps, readFirstJsonlLine, findFilesModifiedAfter } from '../../utils.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import type { ISessionSynchronizer } from '../../types.js';

const OPENCODE_HOME = path.join(os.homedir(), '.opencode');

export const opencodeSessionSynchronizer: ISessionSynchronizer = {
  provider: 'opencode',

  watchPaths: [path.join(OPENCODE_HOME, 'sessions')],

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
    const parsed = await readFirstJsonlLine(filePath, (data) => {
      const d = data as Record<string, unknown>;
      const sessionId = typeof d.sessionId === 'string' ? d.sessionId
        : typeof d.id === 'string' ? d.id : null;
      const projectPath = typeof d.cwd === 'string' ? d.cwd
        : typeof d.workingDir === 'string' ? d.workingDir : null;
      if (!sessionId || !projectPath) return null;
      return { sessionId, projectPath };
    });

    if (!parsed) return null;

    const timestamps = await readFileTimestamps(filePath).catch(() => ({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    projectsDb.createProjectPath(parsed.projectPath);
    sessionsDb.createSession(
      parsed.sessionId,
      'opencode',
      parsed.projectPath,
      undefined,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    return parsed.sessionId;
  },
};
