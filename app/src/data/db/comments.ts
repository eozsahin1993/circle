import { and, asc, count, eq } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { circleMembers, outbox, postComments } from '@/data/db/schema';
import type { NewOutboxEntry } from '@/data/db/outbox';

export type Comment = typeof postComments.$inferSelect;

/** A comment with its author resolved from the roster — what a renderer needs. */
export type CommentWithAuthor = Comment & {
  /** From `circleMembers`, resolved live — null if the author has no roster row on this device yet. */
  authorName: string | null;
  authorPicture: Uint8Array | null;
};

export async function insertComment(comment: Comment): Promise<void> {
  await db.insert(postComments).values(comment);
}

/**
 * Inserts a comment only if that id isn't already stored — how the sync
 * engine applies a `comment` entry, which it may see more than once (see
 * server/SYNC_DESIGN.md invariant 8).
 */
export async function insertCommentIfAbsent(comment: Comment): Promise<void> {
  await db.insert(postComments).values(comment).onConflictDoNothing();
}

/**
 * Inserts a locally-written comment and queues it for sync atomically — a
 * crash between the two would otherwise leave a comment nobody else ever
 * receives, or an outbox row with no comment behind it. Only for comments
 * written on this device; one arriving via sync must never go through
 * here, or it would bounce straight back to the relay it came from.
 */
export async function insertCommentAndEnqueue(comment: Comment, outboxEntry: NewOutboxEntry): Promise<void> {
  db.transaction((tx) => {
    tx.insert(postComments).values(comment).run();
    tx.insert(outbox).values(outboxEntry).run();
  });
}

/**
 * A post's comments, oldest first — a conversation reads top to bottom.
 *
 * Takes `circleId` rather than deriving it through `posts`, which keeps
 * this to a two-table join: bringing `posts` in would put its `circle_id`
 * alongside `circleMembers.circle_id`, and drizzle emits joined columns
 * without `AS` aliases (drizzle-team/drizzle-orm#555) so same-named
 * columns collapse into one. Every column selected here has a source name
 * unique across the two tables; check that still holds before adding one.
 */
export async function getPostComments(circleId: string, postId: string): Promise<CommentWithAuthor[]> {
  const rows = await db
    .select({
      id: postComments.id,
      postId: postComments.postId,
      authorPublicKey: postComments.authorPublicKey,
      body: postComments.body,
      createdAt: postComments.createdAt,
      authorName: circleMembers.name,
      authorPicture: circleMembers.picture,
    })
    .from(postComments)
    .leftJoin(
      circleMembers,
      and(
        eq(circleMembers.circleId, circleId),
        eq(circleMembers.identityPublicKey, postComments.authorPublicKey)
      )
    )
    .where(eq(postComments.postId, postId))
    .orderBy(asc(postComments.createdAt));

  return rows.map((row) => ({ ...row, authorPicture: normalizeBlob(row.authorPicture) }));
}

/** Cheap count for the feed's "N comments" label — no need to fetch every body just to count them. */
export async function getPostCommentCount(postId: string): Promise<number> {
  const rows = await db.select({ count: count() }).from(postComments).where(eq(postComments.postId, postId));
  return rows[0]?.count ?? 0;
}
