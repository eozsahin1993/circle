import { db } from '@/lib/db/connection';
import { sql as migration001 } from '@/lib/db/migrations/001_circles';
import { sql as migration002 } from '@/lib/db/migrations/002_profile';
import { sql as migration003 } from '@/lib/db/migrations/003_posts';

/**
 * Ordered schema migrations — one file per entry, numbered so filenames
 * sort in application order. Each runs exactly once per database, tracked
 * via PRAGMA user_version. Append new files here; never edit one that's
 * already applied to a real device.
 */
const migrations: string[] = [
  migration001,
  migration002,
  migration003,
];

let migrationsPromise: Promise<void> | null = null;

/**
 * Brings the database up to the latest schema version. Safe to call more
 * than once, including concurrently — e.g. React Strict Mode invoking a
 * mount effect twice in development. Every caller awaits the same
 * in-flight run rather than each starting their own; without this, two
 * concurrent calls can both read the same starting `user_version`, both
 * try to apply the same migration, and the second one fails because the
 * table already exists — while the first call's failed sibling transaction
 * rolls back, leaving `user_version` stuck behind the tables it already
 * created, so every future launch repeats the failure.
 */
export function runMigrations(): Promise<void> {
  if (!migrationsPromise) {
    migrationsPromise = runMigrationsOnce();
  }
  return migrationsPromise;
}

async function runMigrationsOnce(): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = row?.user_version ?? 0;

  for (let version = currentVersion; version < migrations.length; version++) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(migrations[version]);
      // PRAGMA doesn't accept bound (?) parameters — this is a plain
      // integer we generated ourselves, not external input, so inlining
      // it is safe.
      await db.execAsync(`PRAGMA user_version = ${version + 1}`);
    });
  }
}
