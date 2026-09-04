import { bytesToHex } from '@noble/curves/utils.js';

import { writePhotoFile } from '@/services/photo-cache';
import { timedSync } from '@/services/timing';

import { generateUUID, hashBytes } from '@/services/crypto';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';
import {
  AttachmentKinds,
  AttachmentStatuses,
  insertPostAndEnqueue,
  OutboxStatuses,
  type NewAttachment,
  type NewOutboxEntry,
  type Post,
} from '@/data/db';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';

export type CreatePostInput = {
  circleId: string;
  caption: string;
  photo: Uint8Array;
};

/**
 * Creates a post and queues it for sync in one local, offline-safe step
 * that always succeeds without network access — the outbox row's
 * encryptedMeta is built and signed right here, once (see the comment on
 * `encryptedMeta` in schema.ts for why the drain step must never
 * re-derive it later). Triggers a drain afterward, but doesn't wait on
 * or fail because of it: a stuck or failed push must never make posting
 * itself feel broken, since the whole point of the outbox is that they're
 * independent. The drain is also naturally retried the next time
 * anything calls it (app resume, another post, pull-to-refresh, ...), so
 * a failure here isn't a lost opportunity, just a deferred one.
 *
 * `photoHash` rides inside the *signed* payload alongside the caption —
 * not a separate mechanism, just one more field something is already
 * signing. It's what lets every reader verify the downloaded photo bytes
 * actually match what this device posted, which the log entry's own
 * signature can't cover on its own (the entry and the blob are uploaded
 * separately) — see services/relay.ts's `getUploadTarget` doc comment for
 * why a shared write token alone can't stand in for this: it proves "a
 * current member," never "this specific author."
 */
export async function createPost(input: CreatePostInput): Promise<void> {
  const identity = await getCircleIdentity(input.circleId);
  if (!identity) throw new Error('No circle identity on this device.');
  const current = await getCurrentContentKey(input.circleId);
  if (!current) throw new Error('No content key on this device.');

  const postId = generateUUID();
  const createdAt = Date.now();
  const photoHash = timedSync(`post.hash(${Math.round(input.photo.length / 1024)}KB)`, () => hashBytes(input.photo));
  const encryptedMeta = buildAndEncryptLogEntry(
    EntryTypes.POST,
    { postId, caption: input.caption, photoHash, createdAt, keyVersion: current.version },
    identity,
    current.key
  );

  const post: Post = {
    id: postId,
    circleId: input.circleId,
    caption: input.caption,
    authorPublicKey: bytesToHex(identity.publicKey),
    createdAt,
  };

  const attachment: NewAttachment = {
    circleId: input.circleId,
    // A post photo's blob address is the postId — the same id
    // `drainOutbox` uploads it under (see services/relay.ts's
    // getUploadTarget).
    entryId: postId,
    kind: AttachmentKinds.POST_PHOTO,
    bytes: input.photo,
    hash: photoHash,
    keyVersion: current.version,
    // Created here, so there is nothing to download.
    status: AttachmentStatuses.FETCHED,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt,
  };

  const outboxEntry: NewOutboxEntry = {
    circleId: input.circleId,
    entryType: EntryTypes.POST,
    entryId: postId,
    status: OutboxStatuses.pending,
    epoch: null,
    encryptedMeta,
  };

  await insertPostAndEnqueue(post, attachment, outboxEntry);
  writePhotoFile(input.circleId, postId, input.photo);

  drainOutbox(input.circleId).catch((err) => console.error('Failed to drain outbox', err));
}
