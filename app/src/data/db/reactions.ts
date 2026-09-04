import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { outbox, postReactions } from '@/data/db/schema';
import type { NewOutboxEntry } from '@/data/db/outbox';

export type PostReaction = typeof postReactions.$inferSelect;

/** Idempotent by construction: the primary key is (post, author, emoji). */
export async function addReaction(reaction: PostReaction): Promise<void> {
  await db.insert(postReactions).values(reaction).onConflictDoNothing();
}

export async function removeReaction(postId: string, authorPublicKey: string, emoji: string): Promise<void> {
  await db
    .delete(postReactions)
    .where(and(eq(postReactions.postId, postId), eq(postReactions.authorPublicKey, authorPublicKey), eq(postReactions.emoji, emoji)));
}

export async function hasReacted(postId: string, authorPublicKey: string, emoji: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(postReactions)
    .where(and(eq(postReactions.postId, postId), eq(postReactions.authorPublicKey, authorPublicKey), eq(postReactions.emoji, emoji)))
    .limit(1);
  return rows.length > 0;
}

export type ReactionSummary = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
};

/** Reactions for a post, grouped by emoji — what the feed actually renders. */
export async function getPostReactionSummary(postId: string, ownPublicKey: string): Promise<ReactionSummary[]> {
  const rows = await db
    .select({
      emoji: postReactions.emoji,
      count: sql<number>`count(*)`,
      reactedByMe: sql<number>`max(case when ${postReactions.authorPublicKey} = ${ownPublicKey} then 1 else 0 end)`,
    })
    .from(postReactions)
    .where(eq(postReactions.postId, postId))
    .groupBy(postReactions.emoji);

  return rows.map((row) => ({ emoji: row.emoji, count: row.count, reactedByMe: row.reactedByMe === 1 }));
}

/**
 * Applies a local reaction toggle and queues it for sync atomically —
 * same reasoning as `insertPostAndEnqueue`. Split across two writes, a
 * crash between them leaves the reaction showing on this device and
 * queued nowhere, so it would never reach anyone and nothing would ever
 * notice: unlike a failed push, there's no pending row left to retry.
 */
export async function toggleReactionAndEnqueue(
  reaction: PostReaction,
  reacted: boolean,
  outboxEntry: NewOutboxEntry
): Promise<void> {
  db.transaction((tx) => {
    if (reacted) {
      tx.insert(postReactions).values(reaction).onConflictDoNothing().run();
    } else {
      tx.delete(postReactions)
        .where(
          and(
            eq(postReactions.postId, reaction.postId),
            eq(postReactions.authorPublicKey, reaction.authorPublicKey),
            eq(postReactions.emoji, reaction.emoji)
          )
        )
        .run();
    }
    tx.insert(outbox).values(outboxEntry).run();
  });
}
