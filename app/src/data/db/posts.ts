import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';

export type Post = {
  id: string;
  circleId: string;
  caption: string;
  photo: Uint8Array;
  createdAt: number;
};

const POST_COLUMNS = `id, circle_id AS circleId, caption, photo, created_at AS createdAt`;

function normalizePost(post: Post): Post {
  return { ...post, photo: normalizeBlob(post.photo) as Uint8Array };
}

export async function insertPost(post: Post): Promise<void> {
  await db.runAsync(
    'INSERT INTO posts (id, circle_id, caption, photo, created_at) VALUES (?, ?, ?, ?, ?)',
    post.id,
    post.circleId,
    post.caption,
    post.photo,
    post.createdAt,
  );
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
  const posts = await db.getAllAsync<Post>(
    `SELECT ${POST_COLUMNS} FROM posts WHERE circle_id = ? ORDER BY created_at DESC`,
    circleId,
  );
  return posts.map(normalizePost);
}
