import { and, desc, eq } from 'drizzle-orm';

import { type Attachment, type NewAttachment } from '@/data/db/attachments';
import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { attachments, circleMembers, posts } from '@/data/db/schema';

export type Post = typeof posts.$inferSelect;

/**
 * Inserts a post and its attachment together — the two are one fact, and a
 * post whose attachment row never landed would be permanently invisible to
 * the download queue. `onConflictDoNothing` on both makes re-applying an
 * already-seen log entry a no-op (server/SYNC_DESIGN.md invariant 8)
 * rather than a primary-key error.
 */
export async function insertPost(post: Post, attachment?: NewAttachment): Promise<void> {
  await db.insert(posts).values(post).onConflictDoNothing();
  if (attachment) {
    await db.insert(attachments).values(attachment).onConflictDoNothing();
  }
}

export async function getPost(id: string): Promise<Post | null> {
  const rows = await db.select().from(posts).where(eq(posts.id, id));
  return rows[0] ?? null;
}

/** A feed row: the post, its author resolved from the roster, and its photo — everything a card renders. */
export type FeedPost = {
  id: string;
  caption: string;
  createdAt: number;
  authorPublicKey: string;
  /** From `circleMembers`, resolved live — null if the author has no roster row yet. */
  authorName: string | null;
  authorPicture: Uint8Array | null;
  /**
   * Whether this post's photo has landed. The bytes themselves are
   * deliberately *not* selected: a feed row only needs to know a photo
   * exists, and the renderer reads it from the photo cache by id. Pulling
   * hundreds of KB per post out of SQLite to decide whether to show an
   * image was most of what made navigating into a feed expensive.
   */
  hasPhoto: boolean;
  photoStatus: Attachment['status'] | null;
};

/**
 * The feed, in one query: posts joined to their author's roster row and
 * their photo attachment. Author name/picture resolve live rather than
 * being denormalized onto the post, so a member renaming themselves
 * updates every post they ever made (server/SYNC_DESIGN.md's "One
 * identifier, four jobs").
 *
 * **Every selected column must have a source name unique across the three
 * tables.** drizzle emits joined columns without `AS` aliases
 * (drizzle-team/drizzle-orm#555), and this driver returns rows keyed by
 * column name — so two same-named columns collapse into one and the later
 * table silently wins. That's why `attachments.createdAt` is not selected
 * here: it would collide with `posts.createdAt` and blank the post's own
 * timestamp. posts.test.ts locks this down; if you add a column here,
 * check its name isn't already taken.
 *
 * Sorts by `created_at`, which is only safe while every post comes from
 * this one device. Once multi-device sync exists, wall-clock time from
 * different devices isn't a trustworthy shared order — the relay assigns
 * each log entry's order at append time, so ordering should come from
 * that server-assigned sequence instead (see server/SYNC_DESIGN.md).
 */
/** Shared by `getCircleFeed` and `getFeedPost` — see the column-collision warning above. */
function feedPostQuery() {
  return db
    .select({
      id: posts.id,
      caption: posts.caption,
      createdAt: posts.createdAt,
      authorPublicKey: posts.authorPublicKey,
      authorName: circleMembers.name,
      authorPicture: circleMembers.picture,
      photoStatus: attachments.status,
    })
    .from(posts)
    .leftJoin(
      circleMembers,
      and(eq(circleMembers.circleId, posts.circleId), eq(circleMembers.identityPublicKey, posts.authorPublicKey))
    )
    .leftJoin(attachments, and(eq(attachments.circleId, posts.circleId), eq(attachments.entryId, posts.id)));
}

function toFeedPost<T extends { authorPicture: Uint8Array | Buffer | null; photoStatus: Attachment['status'] | null }>(
  row: T
): T & { authorPicture: Uint8Array | null; hasPhoto: boolean } {
  return { ...row, authorPicture: normalizeBlob(row.authorPicture), hasPhoto: row.photoStatus === 'fetched' };
}

export async function getCircleFeed(circleId: string): Promise<FeedPost[]> {
  const rows = await feedPostQuery().where(eq(posts.circleId, circleId)).orderBy(desc(posts.createdAt));
  return rows.map(toFeedPost);
}

/** A single feed row, for the post details screen — same shape `getCircleFeed` renders, just one post. */
export async function getFeedPost(circleId: string, postId: string): Promise<FeedPost | null> {
  const rows = await feedPostQuery().where(and(eq(posts.circleId, circleId), eq(posts.id, postId)));
  return rows[0] ? toFeedPost(rows[0]) : null;
}

/**
 * The newest post's photo in a circle, or null — the circle list's cover
 * fallback, and nothing more.
 *
 * Exists because that list used to call `getCircleFeed` per circle, which
 * returns every post with its full photo bytes, to read exactly one
 * thumbnail. On a device with a few circles that dragged megabytes out of
 * SQLite and across the bridge on every visit to the list.
 */
/**
 * The newest post that actually has its photo — id only, no bytes. The
 * circle list uses this as a cover fallback and resolves it through the
 * photo cache, so a screen that only needs a thumbnail never pulls the
 * blob across again. See getNewestPostPhoto for the bytes.
 */
export async function getNewestFetchedPostId(circleId: string): Promise<string | null> {
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(attachments, and(eq(attachments.circleId, posts.circleId), eq(attachments.entryId, posts.id)))
    .where(and(eq(posts.circleId, circleId), eq(attachments.status, 'fetched')))
    .orderBy(desc(posts.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function getNewestPostPhoto(circleId: string): Promise<Uint8Array | null> {
  const rows = await db
    .select({ bytes: attachments.bytes })
    .from(posts)
    .innerJoin(attachments, and(eq(attachments.circleId, posts.circleId), eq(attachments.entryId, posts.id)))
    .where(eq(posts.circleId, circleId))
    .orderBy(desc(posts.createdAt))
    .limit(1);
  return rows[0] ? normalizeBlob(rows[0].bytes) : null;
}
