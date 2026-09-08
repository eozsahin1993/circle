import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { circleMembers, outbox, postReactions } from '@/data/db/schema';
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

/**
 * Reactions for a post, grouped by emoji, in the order each emoji was
 * first used. The ordering is load-bearing rather than cosmetic: the post
 * screen renders these as chips directly above `getPostReactionDetails`'s
 * breakdown of the same reactions, and without an explicit `ORDER BY`
 * SQLite is free to return the groups however its grouping strategy
 * happens to produce them — so the two lists would disagree.
 */
export async function getPostReactionSummary(postId: string, ownPublicKey: string): Promise<ReactionSummary[]> {
  const rows = await db
    .select({
      emoji: postReactions.emoji,
      count: sql<number>`count(*)`,
      reactedByMe: sql<number>`max(case when ${postReactions.authorPublicKey} = ${ownPublicKey} then 1 else 0 end)`,
    })
    .from(postReactions)
    .where(eq(postReactions.postId, postId))
    .groupBy(postReactions.emoji)
    .orderBy(asc(sql`min(${postReactions.createdAt})`));

  return rows.map((row) => ({ emoji: row.emoji, count: row.count, reactedByMe: row.reactedByMe === 1 }));
}

/**
 * The above for a whole page of posts, in one query rather than one per
 * post — same grouping and same ordering, just not repeated N times.
 * Posts with no reactions are absent from the map rather than holding an
 * empty array.
 */
export async function getPostReactionSummaries(
  postIds: string[],
  ownPublicKey: string
): Promise<Map<string, ReactionSummary[]>> {
  const byPost = new Map<string, ReactionSummary[]>();
  if (postIds.length === 0) return byPost;

  const rows = await db
    .select({
      postId: postReactions.postId,
      emoji: postReactions.emoji,
      count: sql<number>`count(*)`,
      reactedByMe: sql<number>`max(case when ${postReactions.authorPublicKey} = ${ownPublicKey} then 1 else 0 end)`,
    })
    .from(postReactions)
    .where(inArray(postReactions.postId, postIds))
    .groupBy(postReactions.postId, postReactions.emoji)
    .orderBy(asc(sql`min(${postReactions.createdAt})`));

  for (const row of rows) {
    const summaries = byPost.get(row.postId) ?? [];
    summaries.push({ emoji: row.emoji, count: row.count, reactedByMe: row.reactedByMe === 1 });
    byPost.set(row.postId, summaries);
  }

  return byPost;
}

/**
 * Everyone who reacted to a post, in the order they first did, each named
 * once however many emoji they used — the post screen lists people, not
 * reactions, so someone who left both a ❤️ and a 🙏 is one name.
 *
 * Deliberately a second query rather than fields on
 * `getPostReactionSummary`: the feed reads that one for every post it
 * renders and needs no names, so the join belongs only here.
 *
 * A reactor with no roster row on this device contributes no name rather
 * than an "Unknown member" placeholder — the chips' counts already
 * account for them, and a list of real names reads better than one padded
 * with apologies.
 */
export async function getPostReactors(circleId: string, postId: string): Promise<string[]> {
  const rows = await db
    .select({ authorPublicKey: postReactions.authorPublicKey, name: circleMembers.name })
    .from(postReactions)
    .leftJoin(
      circleMembers,
      and(eq(circleMembers.circleId, circleId), eq(circleMembers.identityPublicKey, postReactions.authorPublicKey))
    )
    .where(eq(postReactions.postId, postId))
    .orderBy(asc(postReactions.createdAt));

  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows) {
    if (!row.name || seen.has(row.authorPublicKey)) continue;
    seen.add(row.authorPublicKey);
    names.push(row.name);
  }
  return names;
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
