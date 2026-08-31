import { and, asc, eq, isNull } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { circles } from '@/data/db/schema';

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

/** Circles this device is still an active member of — excludes ones it's left. */
export async function getAllCircles(): Promise<Circle[]> {
  const rows = await db.select().from(circles).where(isNull(circles.leftAt)).orderBy(asc(circles.createdAt));
  return rows.map(normalizeCircle);
}

export async function updateCircleName(id: string, name: string): Promise<void> {
  await db.update(circles).set({ name }).where(eq(circles.id, id));
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
