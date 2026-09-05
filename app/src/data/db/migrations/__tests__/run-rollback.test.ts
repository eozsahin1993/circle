import { sql } from 'drizzle-orm';

// A fake migration set, independent of the real one: two valid statements
// followed by a broken one, so the batch is guaranteed to fail partway
// through. Proves the whole batch is one real transaction — not just that
// individual statements are safe to re-run — by checking that `foo`
// (created by the first, successful statement) doesn't survive a failure
// in the third.
jest.mock('@/data/db/migrations/migrations', () => ({
  __esModule: true,
  default: {
    journal: { entries: [{ idx: 0, when: 1000, tag: 'm0000' }] },
    migrations: {
      m0000:
        'CREATE TABLE foo (id text);\n--> statement-breakpoint\nCREATE TABLE bar (id text);\n--> statement-breakpoint\nNOT VALID SQL;',
    },
  },
}));

import { db } from '@/data/db/connection';
import { runMigrations } from '@/data/db/migrations/run';

test('rolls back the whole batch if any statement in it fails, not just the failing one', async () => {
  await expect(runMigrations()).rejects.toThrow();

  const tables = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('foo', 'bar')`
  );
  // foo and bar's CREATE statements both ran successfully before the third
  // statement failed — a real transaction means neither should persist.
  expect(tables).toHaveLength(0);

  const migrations = await db.all<{ idx: number }>(sql`SELECT idx FROM __migrations`);
  expect(migrations).toHaveLength(0);
});
