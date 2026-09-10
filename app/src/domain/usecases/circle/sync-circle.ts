import { getCircle } from '@/data/db';
import { notifyCircleBestEffort } from '@/domain/usecases/push/notify-circle';
import { PushCategories, type PushCategory } from '@/domain/usecases/push/push-categories';
import { EntryTypes } from '@/domain/usecases/circle/log-entry';
import { timed, timedSync } from '@/services/timing';
import { getCurrentContentKey, getMasterSeed } from '@/services/keystore';
import {
  deriveAuthorityChangeMessage,
  deriveAuthorityKeypair,
  deriveDeleteBlobMessage,
  deriveDeleteCircleMessage,
  deriveWriteToken,
  encrypt,
  sign,
} from '@/services/crypto';
import {
  appendEntry,
  BlobAlreadyExistsError,
  BlobDeleteRefusedError,
  changeAuthority,
  deleteCircleOnRelay,
  deleteBlob,
  getUploadTarget,
  uploadBlob,
  type AppendResult,
  type Namespace,
} from '@/services/relay';
import { getPendingOutboxEntries, markOutboxEntrySynced, type OutboxEntry } from '@/data/db';
import { hexToBytes } from '@noble/curves/utils.js';
import { getAttachment } from '@/data/db/attachments';

/**
 * Which relay namespace an entry type belongs in — see
 * server/SYNC_DESIGN.md's "meta"/"content" split. Must agree with which
 * handler map in sync/entry-handlers reads it; a mismatch means the
 * entry is fetched by the wrong pull and silently discarded as an
 * unknown type, on every device including the author's. See the registry
 * test that enforces the agreement.
 */
const META_ENTRY_TYPES: OutboxEntry['entryType'][] = [
  EntryTypes.MEMBER_ADDED,
  EntryTypes.MEMBER_REMOVED,
  EntryTypes.PROFILE_UPDATE,
  EntryTypes.ROLE_CHANGE,
  EntryTypes.COVER_PHOTO_SET,
  EntryTypes.CIRCLE_RENAMED,
  EntryTypes.PUSH_ENABLED,
  EntryTypes.CIRCLE_DELETED,
  // Never actually queued — rotateLog's atomic write-token swap doesn't
  // fit the generic append path (see remove-member.ts) — but listed so
  // the mapping is right if it ever is.
  EntryTypes.KEY_ROTATION,
];

/**
 * Which entry types are worth interrupting someone for, and as what. Types
 * absent from here never notify — a rename or a key rotation is not news.
 */
const PUSH_CATEGORIES: Partial<Record<OutboxEntry['entryType'], PushCategory>> = {
  [EntryTypes.POST]: PushCategories.newPost,
  [EntryTypes.COMMENT]: PushCategories.comment,
  [EntryTypes.REACTION]: PushCategories.reaction,
  [EntryTypes.MEMBER_ADDED]: PushCategories.memberJoined,
};

export function namespaceFor(entryType: OutboxEntry['entryType']): Namespace {
  return META_ENTRY_TYPES.includes(entryType) ? 'meta' : 'content';
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

/**
 * Deletes a blob whose entry has just landed, signing as an authority
 * when this device has that key — the relay lets the uploading account
 * through without one, and needs one from anybody else (see
 * `deleteBlob`). Signing unconditionally costs nothing and saves knowing,
 * at drain time, whether this device wrote the photo: the post's row is
 * already gone by then.
 *
 * A refusal is logged and passed over rather than thrown. The bytes are
 * cleanup; the entry is the truth, and it has already landed. Throwing
 * would leave the row pending forever and block everything queued behind
 * it, which is a much worse outcome than one blob outliving its post.
 */
async function deleteBlobFor(circleId: string, syncId: string, blobEntryId: string, writeToken: Uint8Array): Promise<void> {
  const masterSeed = await getMasterSeed();
  const authority = masterSeed
    ? (() => {
        const keypair = deriveAuthorityKeypair(masterSeed, circleId);
        return {
          publicKey: keypair.publicKey,
          signature: sign(deriveDeleteBlobMessage(syncId, blobEntryId), keypair.secretKey),
        };
      })()
    : undefined;

  try {
    await deleteBlob(syncId, blobEntryId, writeToken, authority);
  } catch (err) {
    if (!(err instanceof BlobDeleteRefusedError)) throw err;
    console.error(`The relay refused to delete blob ${blobEntryId}`, err);
  }
}

/**
 * Sends a queued authority change — see `authorityAction` on the outbox
 * schema. The signature is produced here rather than at queue time
 * because it's over the entry id and the target key, and the authority
 * keypair is seed-derived and never stored; the same reason
 * `deleteBlobFor` derives its own.
 *
 * Writes nothing locally: the entry this pushes comes straight back on
 * the same sync pass, and its replay is the single writer for both the
 * role and its registration.
 */
async function pushAuthorityChange(
  circleId: string,
  syncId: string,
  entry: OutboxEntry,
  keyVersion: number,
  writeToken: Uint8Array
): Promise<AppendResult> {
  const action = entry.authorityAction;
  const target = entry.authorityTargetKey;
  if (!action || !target) throw new Error('Queued authority change is missing its action or target key.');

  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');
  const keypair = deriveAuthorityKeypair(masterSeed, circleId);

  return changeAuthority({
    syncId,
    entryId: entry.entryId,
    encryptedMeta: entry.encryptedMeta,
    keyVersion,
    writeToken,
    action,
    targetAuthorityPublicKey: hexToBytes(target),
    signerAuthorityPublicKey: keypair.publicKey,
    signature: sign(deriveAuthorityChangeMessage(action, syncId, entry.entryId, target), keypair.secretKey),
  });
}

/**
 * Signed at drain time like an authority change, from a key derived here
 * rather than carried on the queued row — leaving this device's keys the
 * only thing that can authorize its own circle's deletion, even hours
 * after the row was written.
 */
async function pushCircleDeletion(
  circleId: string,
  syncId: string,
  entry: OutboxEntry,
  keyVersion: number,
  writeToken: Uint8Array
): Promise<AppendResult> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');
  const keypair = deriveAuthorityKeypair(masterSeed, circleId);

  return deleteCircleOnRelay({
    syncId,
    entryId: entry.entryId,
    encryptedMeta: entry.encryptedMeta,
    keyVersion,
    writeToken,
    signerAuthorityPublicKey: keypair.publicKey,
    signature: sign(deriveDeleteCircleMessage(syncId, entry.entryId), keypair.secretKey),
  });
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

    // Only posts carry a blob; comments and reactions are entry-only, so
    // they fall straight through to the append below.
    if (entry.entryType === EntryTypes.POST) {
      // The bytes live on the attachment, not the post — and they're
      // encrypted under the version that attachment recorded, not
      // whatever is current now, so the blob can never disagree with the
      // entry that references it.
      const attachment = await getAttachment(circleId, entry.entryId);
      if (attachment?.bytes) {
        try {
          const target = await getUploadTarget(circle.syncId, entry.entryId, writeToken);
          const ciphertext = timedSync(
            `push.encrypt(${Math.round(attachment.bytes.length / 1024)}KB)`,
            () => encrypt(attachment.bytes!, current.key)
          );
          await timed('push.upload', () => uploadBlob(target, ciphertext));
        } catch (err) {
          if (!(err instanceof BlobAlreadyExistsError)) throw err;
        }
      }
    }

    // Two entries can't go down the generic append path, because the relay
    // commits each alongside something else or not at all: an authority
    // change with its set mutation, a deletion with the sweep behind it.
    // Both have endpoints of their own.
    const { epoch } = entry.authorityAction
      ? await pushAuthorityChange(circleId, circle.syncId, entry, current.version, writeToken)
      : entry.entryType === EntryTypes.CIRCLE_DELETED
        ? await pushCircleDeletion(circleId, circle.syncId, entry, current.version, writeToken)
        : await appendEntry(circle.syncId, namespace, entry.entryId, entry.encryptedMeta, current.version, writeToken);

    // Notified from here rather than from each usecase: this is the one
    // place that knows an entry actually landed, and it forwards the same
    // ciphertext the log holds, which is all the relay is ever given.
    const category = PUSH_CATEGORIES[entry.entryType];
    if (category !== undefined) {
      notifyCircleBestEffort(circleId, category, current.version, entry.encryptedMeta);
    }

    // After the append, never before: the entry is what every device
    // converges on, and bytes removed ahead of it would leave the photo
    // missing with nothing in the log yet saying why. Idempotent on both
    // sides, so a failure here just retries the whole row.
    if (entry.blobEntryId) {
      await deleteBlobFor(circleId, circle.syncId, entry.blobEntryId, writeToken);
    }

    await markOutboxEntrySynced(entry.sequenceNum, epoch);
  }
}
