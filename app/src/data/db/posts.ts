import { desc, eq } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { posts } from '@/data/db/schema';

export type Post = typeof posts.$inferSelect;

function normalizePost(post: Post): Post {
  return { ...post, photo: normalizeBlob(post.photo) as Uint8Array };
}

export async function insertPost(post: Post): Promise<void> {
  await db.insert(posts).values(post);
}

/**
 * Returns every post in a circle, newest first — this is the feed.
 *
 * Sorts by `created_at`, which is only safe while every post comes from
 * this one device. Once multi-device sync exists, wall-clock time from
 * different devices isn't a trustworthy shared order (see the HLC-ordering
 * notes in project memory) — either this query needs to sort by an HLC
 * column instead, or the sync engine resolves that during merge and keeps
 * writing a correctly-ordered value into `created_at`. Don't assume this
 * still works as-is once posts can come from more than one device.
 */
export async function getCirclePosts(circleId: string): Promise<Post[]> {
  const rows = await db.select().from(posts).where(eq(posts.circleId, circleId)).orderBy(desc(posts.createdAt));
  return rows.map(normalizePost);
}
