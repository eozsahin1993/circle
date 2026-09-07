import {
  OutboxStatuses,
  setPostInAlbumAndEnqueue,
  type NewOutboxEntry,
} from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';

/**
 * Adds a post to its circle's album, or takes it back out, for everyone.
 *
 * The choice is made once when posting (see create-post.ts, which carries
 * it inside the post's own entry for free) — this is the after-the-fact
 * change, which costs an entry of its own, so it exists for "I meant to
 * add that" rather than as something to flip idly.
 *
 * Anyone in the circle can re-file a photo, not just its author: an album
 * is the circle's shared archive, and the entry is signed either way, so
 * every device can see who changed what.
 *
 * Both directions append, because the log is append-only — album
 * membership can't be retracted, only superseded. Replaying content in
 * epoch order therefore leaves whichever change came last as the final
 * state on every device, with no timestamps to compare (same convergence
 * reactions rely on).
 *
 * Triggers a drain but doesn't wait on it, so this works offline; the
 * outbox is retried by every later sync pass anyway.
 */
export async function setAlbumVisibility(circleId: string, postId: string, inAlbum: boolean): Promise<void> {
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No identity for this circle on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const createdAt = Date.now();
  const outboxEntry: NewOutboxEntry = {
    circleId,
    entryType: EntryTypes.ALBUM_VISIBILITY,
    // A fresh id per change, for the same reason reactions mint one: the
    // relay dedupes on entryId, so reusing one would let a re-add read as
    // a retry of the removal and be dropped.
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    encryptedMeta: buildAndEncryptLogEntry(
      EntryTypes.ALBUM_VISIBILITY,
      { postId, inAlbum, createdAt },
      identity,
      current.key
    ),
  };

  await setPostInAlbumAndEnqueue(postId, inAlbum, outboxEntry);

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
}
