import { asc, count, eq } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { postComments } from '@/data/db/schema';

export type Comment = typeof postComments.$inferSelect;

export async function insertComment(comment: Comment): Promise<void> {
  await db.insert(postComments).values(comment);
}

/** A post's comments, oldest first — a conversation reads top to bottom. */
export async function getPostComments(postId: string): Promise<Comment[]> {
  return db.select().from(postComments).where(eq(postComments.postId, postId)).orderBy(asc(postComments.createdAt));
}

/** Cheap count for the feed's "N comments" label — no need to fetch every body just to count them. */
export async function getPostCommentCount(postId: string): Promise<number> {
  const rows = await db.select({ count: count() }).from(postComments).where(eq(postComments.postId, postId));
  return rows[0]?.count ?? 0;
}
