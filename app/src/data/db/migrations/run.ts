import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';

import { db } from '@/data/db/connection';
import migrations from '@/data/db/migrations/migrations';

/**
 * Memoizes the in-flight/completed migration run so every caller awaits the
 * same promise rather than each starting their own — e.g. React Strict Mode
 * invoking a mount effect twice in development. Without this, two
 * concurrent calls can both see no migrations applied yet and both try to
 * create the same tables, and the second fails because they already exist.
 */
let migrationsPromise: Promise<void> | null = null;

export function runMigrations(): Promise<void> {
  if (!migrationsPromise) {
    migrationsPromise = runMigrationsOnce();
  }
  return migrationsPromise;
}

async function runMigrationsOnce(): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = ON;`);
  await migrate(db, migrations);
}
