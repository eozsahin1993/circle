import { bytesToHex } from '@noble/curves/utils.js';

import {
  getPost,
  OutboxStatuses,
  setPostInAlbumAndEnqueue,
  type NewOutboxEntry,
} from '@/data/db';
import { isCircleAdmin } from '@/domain/usecases/circle/invite-to-circle';
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
 * The photo's author or an admin, and nobody else — the same rule
 * `album-visibility.ts`'s predicate enforces on the way back in. Refusing
 * here as well keeps this device from queueing an entry every other device
 * would reject, which would leave the change showing locally and nowhere
 * else.
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

  const post = await getPost(postId);
  if (!post) throw new Error('No such post on this device.');
  if (post.authorPublicKey !== bytesToHex(identity.publicKey) && !(await isCircleAdmin(circleId))) {
    throw new Error('Only the photo’s author or an admin can change the album.');
  }

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
