import { runMigrations } from '@/data/db/migrations';

/** Brings the database up to the latest schema. Call once at app startup. */
export async function initDatabase(): Promise<void> {
  await runMigrations();
}

export * from '@/data/db/circles';
export * from '@/data/db/members';
export * from '@/data/db/posts';
export * from '@/data/db/profile';
