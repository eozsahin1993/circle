import { and, asc, count, eq, gt, isNull, ne, or } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { circles, postComments, posts } from '@/data/db/schema';

export type Circle = typeof circles.$inferSelect;

function normalizeCircle(circle: Circle): Circle {
  return { ...circle, picture: normalizeBlob(circle.picture) };
}

export async function insertCircle(circle: Circle): Promise<void> {
  await db.insert(circles).values(circle);
}

export async function getCircle(id: string): Promise<Circle | null> {
  const rows = await db.select().from(circles).where(eq(circles.id, id));
  return rows[0] ? normalizeCircle(rows[0]) : null;
}

/**
 * The circle list's rows, without the cover blob.
 *
 * `getAllCircles` is `select()` — every column, so a 200KB cover crosses
 * into JS on every read. That crossing is far more expensive than its size
 * suggests: the driver hands drizzle `{data: number[]}`, so `normalizeBlob`
 * materialises one boxed JS number per byte (~1.6MB of array for a 200KB
 * cover) before copying it into a Uint8Array. The circle list re-reads on
 * every focus, so navigating in and out of a feed repeated that until the
 * heap was thrashing and the JS thread stalled for 30-40s a hop.
 *
 * A screen that needs the cover's *pixels* should read it once through the
 * photo cache, not pull the bytes through this query.
 */
export type CircleListRow = Pick<Circle, 'id' | 'name' | 'createdAt' | 'lastViewedAt'>;

export async function listCircles(): Promise<CircleListRow[]> {
  return db
    .select({ id: circles.id, name: circles.name, createdAt: circles.createdAt, lastViewedAt: circles.lastViewedAt })
    .from(circles)
    .where(isNull(circles.leftAt))
    .orderBy(asc(circles.createdAt));
}

/**
 * One circle without its cover blob — for the screens that only show its
 * name. `getCircle` is select(), so reaching for it just to read `.name`
 * pulls a ~200KB picture through the driver as one boxed JS number per
 * byte. Use this unless you actually need the bytes.
 */
export async function getCircleSummary(id: string): Promise<CircleListRow | null> {
  const rows = await db
    .select({ id: circles.id, name: circles.name, createdAt: circles.createdAt, lastViewedAt: circles.lastViewedAt })
    .from(circles)
    .where(eq(circles.id, id));
  return rows[0] ?? null;
}

/**
 * Just one circle's cover bytes. Its only caller writes them straight into
 * the photo cache, so this runs once per circle rather than per focus —
 * see listCircles above for why pulling the blob repeatedly is so costly.
 */
export async function getCircleCoverBytes(id: string): Promise<Uint8Array | null> {
  const rows = await db.select({ picture: circles.picture }).from(circles).where(eq(circles.id, id));
  return rows[0] ? normalizeBlob(rows[0].picture) : null;
}

/** Circles this device is still an active member of — excludes ones it's left. */
export async function getAllCircles(): Promise<Circle[]> {
  const rows = await db.select().from(circles).where(isNull(circles.leftAt)).orderBy(asc(circles.createdAt));
  return rows.map(normalizeCircle);
}

/**
 * Records how far this device has replayed one namespace of a circle's
 * log. Always set to the epoch of the last entry actually *processed*,
 * never blindly to the relay's reported latest — a short page would
 * otherwise skip everything it didn't return (server/SYNC_DESIGN.md's
 * "Read / sync").
 */
export async function advanceCircleCursor(id: string, namespace: 'meta' | 'content', epoch: number): Promise<void> {
  const column = namespace === 'meta' ? { metaCursor: epoch } : { contentCursor: epoch };
  await db.update(circles).set(column).where(eq(circles.id, id));
}

/** Marks this circle as opened just now — the circle-list badge's "new post" floor. */
export async function markCircleViewed(id: string): Promise<void> {
  await db.update(circles).set({ lastViewedAt: Date.now() }).where(eq(circles.id, id));
}

/**
 * The circle-list badge's count: new posts plus new comments, excluding
 * `ownPublicKey` (no badge for your own actions) and never touching
 * `post_reactions` — reactions are too low-effort a signal, and there's no
 * "who reacted" UI to attribute one with (see the design discussion this
 * came out of).
 *
 * `circleCreatedAt`/`circleLastViewedAt` come from the caller's own
 * `CircleListRow` rather than being looked up again here — `listCircles()`
 * already has them, and this runs once per circle in the list.
 *
 * A comment floors against `circleCreatedAt`, not just the post's own
 * `lastViewedAt`: a post that's never been individually scrolled past or
 * opened has a permanently-null `lastViewedAt`, and without this floor its
 * entire pre-join comment history would count as unread forever for a
 * freshly-joined circle.
 */
export async function getUnreadCount(
  circleId: string,
  ownPublicKey: string,
  circleCreatedAt: number,
  circleLastViewedAt: number
): Promise<number> {
  const newPosts = await db
    .select({ count: count() })
    .from(posts)
    .where(and(eq(posts.circleId, circleId), ne(posts.authorPublicKey, ownPublicKey), gt(posts.createdAt, circleLastViewedAt)));

  const newComments = await db
    .select({ count: count() })
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

  return (newPosts[0]?.count ?? 0) + (newComments[0]?.count ?? 0);
}

export async function updateCircleName(id: string, name: string): Promise<void> {
  await db.update(circles).set({ name }).where(eq(circles.id, id));
}

export async function updateCirclePicture(id: string, picture: Uint8Array | null): Promise<void> {
  await db.update(circles).set({ picture }).where(eq(circles.id, id));
}

/**
 * Marks this device as having left the circle — a soft leave, not a
 * delete. Already-synced posts stay in SQLite as a local archive; this
 * just removes the circle from the active list and stops it appearing as
 * something you can still post to. Pair with `deleteCircleKeys` so this
 * device also loses the ability to sign new posts or decrypt anything new.
 */
export async function markCircleLeft(id: string): Promise<void> {
  await db.update(circles).set({ leftAt: Date.now() }).where(and(eq(circles.id, id), isNull(circles.leftAt)));
}

/**
 * Deletes a circle and, via ON DELETE CASCADE, its entire roster with it —
 * a hard delete, unlike `markCircleLeft`. Only removes this device's own
 * copy; propagating the deletion to every other member's device is a
 * `circle_deleted`-style event on the relay's per-circle log once that
 * exists (see server/DESIGN.md) — not something this function can do on
 * its own today.
 */
export async function deleteCircle(id: string): Promise<void> {
  await db.delete(circles).where(eq(circles.id, id));
}
