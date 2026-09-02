import { db } from '@/data/db/connection';
import { circleInvites, circleMembers, circles, deviceProfile, outbox, postComments, postReactions, posts } from '@/data/db/schema';

/** Every circle id ever stored locally, including ones this device has left — unlike getAllCircles, nothing is filtered out, since resetAllLocalData's caller needs to clean up keystore material for all of them, not just active ones. */
export async function getAllCircleIds(): Promise<string[]> {
  const rows = await db.select({ id: circles.id }).from(circles);
  return rows.map((r) => r.id);
}

/**
 * Wipes every locally-stored row — circles, posts, comments, reactions,
 * invites, membership, the outbox, and the device profile. Deletes
 * children before parents explicitly rather than relying on SQLite
 * foreign-key cascade, since this connection doesn't turn PRAGMA
 * foreign_keys on. Doesn't touch the Keychain/Keystore (circle identities,
 * circle secrets, the master seed) — that's a separate concern, see
 * services/keystore.ts; callers that want a full device reset need both.
 */
export async function resetAllLocalData(): Promise<void> {
  await db.delete(postComments);
  await db.delete(postReactions);
  await db.delete(outbox);
  await db.delete(posts);
  await db.delete(circleInvites);
  await db.delete(circleMembers);
  await db.delete(circles);
  await db.delete(deviceProfile);
}
