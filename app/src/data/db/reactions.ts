import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { postReactions } from '@/data/db/schema';

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
