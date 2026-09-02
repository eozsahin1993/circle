import { sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { runMigrations } from '@/data/db/migrations/run';

test('applies every real migration in one pass', async () => {
  await expect(runMigrations()).resolves.toBeUndefined();

  const tables = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
  const tableNames = tables.map((t) => t.name);
  expect(tableNames).toEqual(
    expect.arrayContaining(['circles', 'circle_members', 'posts', 'pending_join_requests', '__migrations'])
  );

  // circle_members.role only exists after 0001's ALTER TABLE ADD COLUMN ran.
  const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(circle_members)`);
  expect(columns.map((c) => c.name)).toContain('role');
});
