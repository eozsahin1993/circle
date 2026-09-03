import { deriveCircleLogId, encrypt } from '@/services/crypto';
import { getCircleSecret } from '@/services/keystore';
import { appendEntry, uploadBlob } from '@/services/relay';
import { getPendingOutboxEntries, markOutboxEntrySynced } from '@/data/db';
import { getPost } from '@/data/db/posts';

/**
 * Pushes every pending outbox entry for a circle, strictly in the order
 * they were created — one at a time, stopping on the first failure
 * (offline, relay error) rather than reordering around it, since the
 * whole point of the outbox's ordering is that push order matches local
 * creation order exactly. Safe to call repeatedly (e.g. after a failed
 * attempt, or opportunistically whenever connectivity looks likely):
 * `appendEntry` is idempotent per entryId, and an entry only gets marked
 * synced once both the metadata append and the blob upload succeed, so a
 * retry after a partial failure just repeats whichever half didn't land.
 */
export async function drainOutbox(circleId: string): Promise<void> {
  const secret = await getCircleSecret(circleId);
  if (!secret) throw new Error('No circle secret on this device.');
  const circleLogId = deriveCircleLogId(secret);

  const pending = await getPendingOutboxEntries(circleId);
  for (const entry of pending) {
    const { epoch, upload } = await appendEntry(circleLogId, entry.localId, entry.encryptedMeta);

    if (entry.entryType === 'post') {
      const post = await getPost(entry.localId);
      if (post) {
        await uploadBlob(upload, encrypt(post.photo, secret));
      }
    }

    await markOutboxEntrySynced(entry.sequenceNum, epoch);
  }
}
