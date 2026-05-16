import { getConnection } from '@/modules/database/connection.js';
import { runMigrations } from '@/modules/database/migrations.js';

export async function initializeDatabase(): Promise<void> {
  getConnection(); // ensures the connection is open and app_config bootstrapped
  runMigrations();
  console.log('Database initialized successfully');
}
