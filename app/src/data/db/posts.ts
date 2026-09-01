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

export async function getPost(id: string): Promise<Post | null> {
  const rows = await db.select().from(posts).where(eq(posts.id, id));
  return rows[0] ? normalizePost(rows[0]) : null;
}

/**
 * Returns every post in a circle, newest first — this is the feed.
 *
 * Sorts by `created_at`, which is only safe while every post comes from
 * this one device. Once multi-device sync exists, wall-clock time from
 * different devices isn't a trustworthy shared order — see `server/DESIGN.md`
 * (the "one append-only, epoch-indexed log per circle" section). The
 * relay assigns each log entry's order at append time, so once sync
 * exists, ordering should come from that server-assigned sequence, not
 * from comparing `created_at` across devices. Don't assume this query
 * still works as-is once posts can come from more than one device.
 */
export async function getCirclePosts(circleId: string): Promise<Post[]> {
  const rows = await db.select().from(posts).where(eq(posts.circleId, circleId)).orderBy(desc(posts.createdAt));
  return rows.map(normalizePost);
}
