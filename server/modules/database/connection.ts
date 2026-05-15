import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { APP_CONFIG_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveDatabasePath(): string {
  return process.env.DATABASE_PATH || resolveLegacyDatabasePath();
}

function resolveLegacyDatabasePath(): string {
  // Legacy path: server/database/auth.db (relative to server root)
  const serverDir = path.resolve(__dirname, '..', '..');
  return path.join(serverDir, 'database', 'auth.db');
}

function ensureDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Created database directory:', dir);
  }
}

function migrateLegacyDatabase(dbPath: string): void {
  const legacyPath = resolveLegacyDatabasePath();
  if (dbPath === legacyPath) return;
  if (fs.existsSync(dbPath)) return;
  if (!fs.existsSync(legacyPath)) return;

  try {
    fs.copyFileSync(legacyPath, dbPath);
    console.log(`[MIGRATION] Copied database from ${legacyPath} to ${dbPath}`);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(legacyPath + suffix)) {
        fs.copyFileSync(legacyPath + suffix, dbPath + suffix);
      }
    }
  } catch (err: any) {
    console.warn(`[MIGRATION] Could not copy legacy database: ${err.message}`);
  }
}

let globalConnection: InstanceType<typeof Database> | null = null;

export function getConnection(): InstanceType<typeof Database> {
  if (globalConnection) return globalConnection;

  const dbPath = resolveDatabasePath();
  ensureDatabaseDirectory(dbPath);
  migrateLegacyDatabase(dbPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Bootstrap app_config so auth middleware can read the JWT secret
  // before the full schema migration runs.
  db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);

  globalConnection = db;
  return db;
}

export function closeConnection(): void {
  if (globalConnection) {
    globalConnection.close();
    globalConnection = null;
  }
}
