// @vitest-environment node
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, describe, expect, it } from 'vitest';

const databasePath = path.join(os.tmpdir(), `cloudcli-fresh-${crypto.randomUUID()}.db`);
const scriptPath = `${databasePath}.mts`;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('fresh database compatibility', () => {
  it('supports session renames immediately after initialization', async () => {
    await fs.writeFile(databasePath, '');
    const databaseModuleUrl = pathToFileURL(path.join(repositoryRoot, 'server', 'database', 'db.js')).href;
    const script = `
      const { sessionNamesDb, sessionsDb } = await import(${JSON.stringify(databaseModuleUrl)});
      sessionsDb.createSession(
        'fresh-session',
        'claude',
        'C:\\\\summary-ui-test',
        undefined,
        undefined,
        undefined,
        'C:\\\\summary-ui-test\\\\fresh-session.jsonl'
      );
      sessionNamesDb.setName('fresh-session', 'claude', 'Manual title');
      if (sessionNamesDb.getName('fresh-session', 'claude') !== 'Manual title') {
        throw new Error('Legacy session name was not persisted');
      }
      if (sessionsDb.getSessionById('fresh-session')?.custom_name !== 'Manual title') {
        throw new Error('Session row custom name was not persisted');
      }
    `;
    await fs.writeFile(scriptPath, script);
    const result = spawnSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'server/tsconfig.json', scriptPath],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DATABASE_PATH: databasePath },
        encoding: 'utf8',
      }
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

afterAll(async () => {
  await fs.unlink(databasePath).catch(() => {});
  await fs.unlink(`${databasePath}-shm`).catch(() => {});
  await fs.unlink(`${databasePath}-wal`).catch(() => {});
  await fs.unlink(scriptPath).catch(() => {});
});
