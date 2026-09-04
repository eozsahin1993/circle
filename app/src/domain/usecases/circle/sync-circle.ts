import { getCircle } from '@/data/db';
import { getCurrentContentKey } from '@/services/keystore';
import { deriveWriteToken, encrypt } from '@/services/crypto';
import { appendEntry, BlobAlreadyExistsError, getUploadTarget, uploadBlob, type Namespace } from '@/services/relay';
import { getPendingOutboxEntries, markOutboxEntrySynced, type OutboxEntry } from '@/data/db';
import { getAttachment } from '@/data/db/attachments';

/** Which relay namespace a locally-queued entry type belongs in — see server/SYNC_DESIGN.md's "meta"/"content" split. */
function namespaceFor(entryType: OutboxEntry['entryType']): Namespace {
  return entryType === 'member_added' ? 'meta' : 'content';
}

/**
 * Pushes every pending outbox entry, strictly in creation order, stopping
 * on the first failure rather than reordering around it. Safe to retry:
 * `appendEntry` is idempotent per entryId, and an entry is only marked
 * synced once its blob (if any) and its append both succeed.
 *
 * For a 'post', the blob is uploaded *before* the entry is appended (see
 * server/SYNC_DESIGN.md's "Post" operation) — a crash in between leaves a
 * harmless orphaned blob rather than a permanent entry pointing at
 * nothing, which an immutable log could never fix. `BlobAlreadyExistsError`
 * on retry means the previous attempt's upload actually succeeded; treat
 * it as done, not as a failure.
 *
 * Only one drain runs per circle at a time. Drains are triggered from
 * several uncoordinated places — creating a post and completing a join
 * both fire one, and every sync pass runs one too — so they genuinely
 * overlap. Two concurrent drains would read the same pending rows and
 * both push them: the relay's per-entryId idempotency means that
 * converges rather than duplicating, but it re-uploads blobs and doubles
 * the requests for nothing. A second caller joins the drain already
 * running instead.
 */
const inFlightDrains = new Map<string, Promise<void>>();
const rerunRequested = new Set<string>();

/**
 * Drains repeatedly until a pass finds nothing new. The loop matters
 * because joining an in-flight drain is not the same as being pushed by
 * it: that drain already read its batch, so anything queued after that
 * read would sit unsent until some later trigger happened along. Posting
 * during a sync pass is the ordinary case, not a rare one — so a caller
 * arriving mid-drain asks for one more pass rather than being quietly
 * dropped.
 */
async function drainUntilQuiet(circleId: string): Promise<void> {
  try {
    do {
      rerunRequested.delete(circleId);
      await pushPendingEntries(circleId);
    } while (rerunRequested.has(circleId));
  } finally {
    rerunRequested.delete(circleId);
    inFlightDrains.delete(circleId);
  }
}

export function drainOutbox(circleId: string): Promise<void> {
  const running = inFlightDrains.get(circleId);
  if (running) {
    rerunRequested.add(circleId);
    return running;
  }

  const drain = drainUntilQuiet(circleId);
  inFlightDrains.set(circleId, drain);
  return drain;
}

async function pushPendingEntries(circleId: string): Promise<void> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('No local circle row for this id.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');
  const writeToken = deriveWriteToken(current.key);

  const pending = await getPendingOutboxEntries(circleId);
  for (const entry of pending) {
    const namespace = namespaceFor(entry.entryType);

    if (entry.entryType === 'post') {
      // The bytes live on the attachment, not the post — and they're
      // encrypted under the version that attachment recorded, not
      // whatever is current now, so the blob can never disagree with the
      // entry that references it.
      const attachment = await getAttachment(circleId, entry.localId);
      if (attachment?.bytes) {
        try {
          const target = await getUploadTarget(circle.syncId, entry.localId, writeToken);
          await uploadBlob(target, encrypt(attachment.bytes, current.key));
        } catch (err) {
          if (!(err instanceof BlobAlreadyExistsError)) throw err;
        }
      }
    }

    const { epoch } = await appendEntry(circle.syncId, namespace, entry.localId, entry.encryptedMeta, current.version, writeToken);
    await markOutboxEntrySynced(entry.sequenceNum, epoch);
  }
}
