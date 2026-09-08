import { bytesToHex } from '@noble/curves/utils.js';

import { deletePostAndEnqueue, getPost, OutboxStatuses, type NewOutboxEntry } from '@/data/db';
import { isCircleAdmin } from '@/domain/usecases/circle/invite-to-circle';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';
import { deletePhotoFile } from '@/services/photo-cache';

/**
 * Removes a photo from the circle, for everyone.
 *
 * The photo's author or an admin, and nobody else — the same rule
 * `post-delete.ts`'s predicate enforces on the way back in, refused here
 * too so this device can't queue an entry every other device rejects and
 * be left as the only one where the photo is gone.
 *
 * What this can't do is unsend: the blob was pushed to the relay and every
 * member's device may already hold the decrypted bytes. It removes the
 * photo from the circle going forward, which is what deleting means here —
 * not a guarantee about copies already made.
 *
 * Triggers a drain but doesn't wait on it, so this works offline; the
 * outbox is retried by every later sync pass anyway.
 */
export async function deletePost(circleId: string, postId: string): Promise<void> {
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No identity for this circle on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const post = await getPost(postId);
  if (!post) throw new Error('No such post on this device.');
  if (post.authorPublicKey !== bytesToHex(identity.publicKey) && !(await isCircleAdmin(circleId))) {
    throw new Error('Only the photo’s author or an admin can delete it.');
  }

  const outboxEntry: NewOutboxEntry = {
    circleId,
    entryType: EntryTypes.POST_DELETE,
    // Not the post's id: that one is already taken at the relay, by the
    // post itself, and entryId is its idempotency key.
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    // The photo's bytes, deleted once this entry lands (see drainOutbox).
    blobEntryId: postId,
    encryptedMeta: buildAndEncryptLogEntry(
      EntryTypes.POST_DELETE,
      { postId, createdAt: Date.now() },
      identity,
      current.key
    ),
  };

  await deletePostAndEnqueue(circleId, postId, outboxEntry);
  deletePhotoFile(circleId, postId);

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
}
