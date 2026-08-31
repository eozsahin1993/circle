import { runMigrations } from '@/lib/db/migrations';

/** Brings the database up to the latest schema. Call once at app startup. */
export async function initDatabase(): Promise<void> {
  await runMigrations();
}

export * from '@/lib/db/circles';
export * from '@/lib/db/members';
export * from '@/lib/db/posts';
export * from '@/lib/db/profile';
