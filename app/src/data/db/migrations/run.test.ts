import { sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { runMigrations } from '@/data/db/migrations/run';

test('applies every real migration in one pass', async () => {
  await expect(runMigrations()).resolves.toBeUndefined();

  const tables = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
  const tableNames = tables.map((t) => t.name);
  expect(tableNames).toEqual(
    expect.arrayContaining(['circles', 'circle_members', 'posts', 'attachments', 'pending_join_requests', '__migrations'])
  );

  // Every migration declares its table's final column set (ALTERs were
  // folded back into whichever migration creates the table), so a column
  // added late in the schema's life still has to be present after a
  // single pass — `role` and `attachments.kind` are the canaries.
  const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(circle_members)`);
  expect(columns.map((c) => c.name)).toContain('role');

  const attachmentColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(attachments)`);
  expect(attachmentColumns.map((c) => c.name)).toEqual(
    expect.arrayContaining(['circle_id', 'entry_id', 'kind', 'bytes', 'hash', 'key_version', 'status'])
  );
});
