import { getConnection } from '@/modules/database/connection.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { backfillSessionsFromFileSystem } from '@/modules/database/backfill.js';

export async function initializeDatabase(): Promise<void> {
  getConnection(); // ensures the connection is open and app_config bootstrapped
  runMigrations();
  console.log('Database initialized successfully');

  // Run in background — do not block HTTP server startup
  backfillSessionsFromFileSystem().catch(err =>
    console.error('[backfill] Error during session backfill:', err)
  );
}
