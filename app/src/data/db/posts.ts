import { and, desc, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';

import { type Attachment, type NewAttachment } from '@/data/db/attachments';
import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { attachments, circleMembers, outbox, postComments, postReactions, posts } from '@/data/db/schema';
import type { NewOutboxEntry } from '@/data/db/outbox';

export type Post = typeof posts.$inferSelect;

/**
 * Inserts a post and its attachment together — the two are one fact, and a
 * post whose attachment row never landed would be permanently invisible to
 * the download queue. `onConflictDoNothing` on both makes re-applying an
 * already-seen log entry a no-op rather than a primary-key error — sync
 * can redeliver the same entry more than once, and replay has to stay
 * harmless when it does.
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
  /** Whether this photo is in the circle's album — see set-album-visibility.ts. */
  inAlbum: boolean;
};

/**
 * The feed, in one query: posts joined to their author's roster row and
 * their photo attachment. Author name/picture resolve live rather than
 * being denormalized onto the post, so a member renaming themselves
 * updates every post they ever made — a post carries only the author's
 * pubkey, never a name/picture snapshot, so there's nothing to go stale.
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
 * that server-assigned sequence instead.
 */
/** Shared by `getCircleFeed`, `getCircleFeedPage` and `getFeedPost` — see the column-collision warning above. */
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
      inAlbum: posts.inAlbum,
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

/** Every post in a circle, newest first, with no limit — mainly a test helper now that the feed screen itself pages through `getCircleFeedPage`. */
export async function getCircleFeed(circleId: string): Promise<FeedPost[]> {
  const rows = await feedPostQuery().where(eq(posts.circleId, circleId)).orderBy(desc(posts.createdAt));
  return rows.map(toFeedPost);
}

/** Identifies a post's position in the newest-first feed order — `id` only breaks a tie on `createdAt`, which alone isn't unique. */
export type FeedCursor = { createdAt: number; id: string };

export type FeedPage = { posts: FeedPost[]; hasMore: boolean };

/**
 * One page of the feed, newest first: everything strictly older than
 * `cursor` (or the newest page, given `null`), up to `limit` posts, plus
 * whether any older posts remain.
 */
export async function getCircleFeedPage(circleId: string, cursor: FeedCursor | null, limit: number): Promise<FeedPage> {
  const rows = await feedPostQuery()
    .where(
      and(
        eq(posts.circleId, circleId),
        cursor ? or(lt(posts.createdAt, cursor.createdAt), and(eq(posts.createdAt, cursor.createdAt), lt(posts.id, cursor.id))) : undefined
      )
    )
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit + 1);

  return { posts: rows.slice(0, limit).map(toFeedPost), hasMore: rows.length > limit };
}

/** A single feed row, for the post details screen — same shape `getCircleFeedPage` renders, just one post. */
export async function getFeedPost(circleId: string, postId: string): Promise<FeedPost | null> {
  const rows = await feedPostQuery().where(and(eq(posts.circleId, circleId), eq(posts.id, postId)));
  return rows[0] ? toFeedPost(rows[0]) : null;
}

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

/** When the newest post in a circle was made — the circle list's "Last added…" line. Null for a circle with no posts yet. */
export async function getNewestPostCreatedAt(circleId: string): Promise<number | null> {
  const rows = await db
    .select({ createdAt: posts.createdAt })
    .from(posts)
    .where(eq(posts.circleId, circleId))
    .orderBy(desc(posts.createdAt))
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

/** Marks a post as scrolled into view (or opened) just now — clears its "new comments" marker up to this moment. */
export async function markPostViewed(id: string): Promise<void> {
  await db.update(posts).set({ lastViewedAt: Date.now() }).where(eq(posts.id, id));
}

/** One photo in the album grid — id, date and download state; the pixels come from the photo cache by id. */
export type AlbumPhoto = {
  id: string;
  createdAt: number;
  photoStatus: Attachment['status'];
};

/**
 * Every photo in this circle's album, newest first.
 *
 * Ids and timestamps only, never `attachments.bytes` — see `FeedPost.hasPhoto`'s
 * doc comment on what pulling blobs through this driver costs. The grid
 * resolves each one through the photo cache instead, same as the feed.
 *
 * Includes photos whose bytes haven't landed, carrying the attachment's
 * status so the grid can hold their place — filtering them out here made a
 * partly-synced album quietly shorter than the circle's, with no way to
 * tell that from an album that really has fewer photos in it.
 */
export async function getAlbumPhotos(circleId: string): Promise<AlbumPhoto[]> {
  return db
    .select({ id: posts.id, createdAt: posts.createdAt, photoStatus: attachments.status })
    .from(posts)
    .innerJoin(attachments, and(eq(attachments.circleId, posts.circleId), eq(attachments.entryId, posts.id)))
    .where(and(eq(posts.circleId, circleId), eq(posts.inAlbum, true)))
    .orderBy(desc(posts.createdAt));
}

/**
 * Adds or removes a post from its circle's album and queues the change for
 * every other device, atomically — same reasoning as
 * `toggleReactionAndEnqueue`: split across two writes, a crash between
 * them leaves the change showing here and queued nowhere, with no pending
 * row left to notice it never went out.
 */
export async function setPostInAlbumAndEnqueue(
  id: string,
  inAlbum: boolean,
  outboxEntry: NewOutboxEntry
): Promise<void> {
  db.transaction((tx) => {
    tx.update(posts).set({ inAlbum }).where(eq(posts.id, id)).run();
    tx.insert(outbox).values(outboxEntry).run();
  });
}

/** Adds or removes a post from the album locally — the sync path's half of the above. */
export async function setPostInAlbum(id: string, inAlbum: boolean): Promise<void> {
  await db.update(posts).set({ inAlbum }).where(eq(posts.id, id));
}

/**
 * Removes a post and everything derived from it.
 *
 * Children go explicitly, child-first, rather than by foreign-key cascade
 * — same choice `resetAllLocalData` makes. `PRAGMA foreign_keys` is a
 * per-connection setting SQLite defaults to *off*, so cascade only fires
 * where something has turned it on for that exact connection; a path that
 * reaches this before `runMigrations` has, or a future second connection,
 * would silently orphan every comment and reaction instead of failing.
 * Two extra statements inside the transaction cost nothing and don't
 * depend on runtime state.
 *
 * The attachment has no foreign key at all — it's addressed by (circleId,
 * entryId) so a blob can exist before its post — and its row must go or
 * the download queue keeps chasing bytes for a post that isn't there.
 *
 * Removes nothing at the relay: the log is append-only, so a deletion is
 * an entry every device applies (see post-delete.ts). The blob is a
 * separate, explicit call — see `deletePost`.
 */
export async function deletePostLocally(circleId: string, id: string): Promise<void> {
  db.transaction((tx) => {
    tx.delete(postComments).where(eq(postComments.postId, id)).run();
    tx.delete(postReactions).where(eq(postReactions.postId, id)).run();
    tx.delete(attachments)
      .where(and(eq(attachments.circleId, circleId), eq(attachments.entryId, id)))
      .run();
    tx.delete(posts).where(eq(posts.id, id)).run();
  });
}

/** Deletes a post here and queues the deletion for every other device, atomically — same reasoning as `setPostInAlbumAndEnqueue`. */
export async function deletePostAndEnqueue(
  circleId: string,
  id: string,
  outboxEntry: NewOutboxEntry
): Promise<void> {
  db.transaction((tx) => {
    tx.delete(postComments).where(eq(postComments.postId, id)).run();
    tx.delete(postReactions).where(eq(postReactions.postId, id)).run();
    tx.delete(attachments)
      .where(and(eq(attachments.circleId, circleId), eq(attachments.entryId, id)))
      .run();
    tx.delete(posts).where(eq(posts.id, id)).run();
    tx.insert(outbox).values(outboxEntry).run();
  });
}

/**
 * Which posts in this circle have a comment worth a "new comments" marker
 * on their feed card — same rule `getUnreadCount` sums for the circle-list
 * badge, but returning which posts qualify instead of a total. Kept
 * separate from `feedPostQuery` rather than folded into it, given that
 * query's column-collision fragility (see its doc comment above).
 */
export async function getUnseenCommentPostIds(
  circleId: string,
  ownPublicKey: string,
  circleCreatedAt: number
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ postId: postComments.postId })
    .from(postComments)
    .innerJoin(posts, eq(posts.id, postComments.postId))
    .where(
      and(
        eq(posts.circleId, circleId),
        ne(postComments.authorPublicKey, ownPublicKey),
        gt(postComments.createdAt, circleCreatedAt),
        or(isNull(posts.lastViewedAt), gt(postComments.createdAt, posts.lastViewedAt))
      )
    );
  return rows.map((row) => row.postId);
}
