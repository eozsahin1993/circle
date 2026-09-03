import { and, asc, eq } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { type NewAttachment } from '@/data/db/attachments';
import { type Post } from '@/data/db/posts';
import { attachments, outbox, posts } from '@/data/db/schema';

export type OutboxEntry = typeof outbox.$inferSelect;
export type NewOutboxEntry = Omit<OutboxEntry, 'sequenceNum'>;

/** The states an outbox entry can be in — see `status` on `outbox` in schema.ts. */
export type OutboxStatus = OutboxEntry['status'];

/** Named values for `OutboxStatus`, so call sites never hand-type the raw strings. */
export const OutboxStatuses: Record<OutboxStatus, OutboxStatus> = {
  pending: 'pending',
  synced: 'synced',
};

function normalizeOutboxEntry(entry: OutboxEntry): OutboxEntry {
  return { ...entry, encryptedMeta: normalizeBlob(entry.encryptedMeta) as Uint8Array };
}

export async function insertOutboxEntry(entry: NewOutboxEntry): Promise<void> {
  await db.insert(outbox).values(entry);
}

/** Every not-yet-synced entry for a circle, in the exact order they were created. */
export async function getPendingOutboxEntries(circleId: string): Promise<OutboxEntry[]> {
  const rows = await db
    .select()
    .from(outbox)
    .where(and(eq(outbox.circleId, circleId), eq(outbox.status, OutboxStatuses.pending)))
    .orderBy(asc(outbox.sequenceNum));
  return rows.map(normalizeOutboxEntry);
}

/** Marks an entry as pushed — called once the relay has confirmed it and assigned an epoch. */
export async function markOutboxEntrySynced(sequenceNum: number, epoch: number): Promise<void> {
  await db.update(outbox).set({ status: OutboxStatuses.synced, epoch }).where(eq(outbox.sequenceNum, sequenceNum));
}

/**
 * Inserts a locally-created post, its photo attachment, and the outbox row
 * that will push it, atomically — a crash between any two would otherwise
 * leave a post that never gets pushed, an outbox row with no post behind
 * it, or a post whose photo the download queue would try to fetch back
 * from the relay despite it having originated here.
 *
 * The attachment goes in as `status: 'fetched'` with bytes already in
 * hand: a locally-created post has nothing to download. Only for posts
 * created on this device — a post materialized by `pullLog` must never go
 * through here, or it would bounce straight back out to the relay.
 */
export async function insertPostAndEnqueue(
  post: Post,
  attachment: NewAttachment,
  outboxEntry: NewOutboxEntry
): Promise<void> {
  db.transaction((tx) => {
    tx.insert(posts).values(post).run();
    tx.insert(attachments).values(attachment).run();
    tx.insert(outbox).values(outboxEntry).run();
  });
}
