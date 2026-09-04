import { bytesToHex } from '@noble/curves/utils.js';

import { insertCommentAndEnqueue, OutboxStatuses } from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';

/**
 * Adds a comment as this device's own circle identity, and queues it for
 * every other member. No-ops on an empty/whitespace-only body.
 *
 * Built and signed here, once, then stored as ciphertext — the drain must
 * send byte-for-byte what was signed, since the relay's idempotency keys
 * on entryId rather than payload (see `encryptedMeta` on `outbox` in
 * schema.ts). The author is carried only as a public key: the name shown
 * beside a comment resolves live from the roster at render time, so
 * renaming yourself updates every comment you ever wrote.
 *
 * Triggers a drain but doesn't wait on it — commenting has to work
 * offline, and the outbox is retried by every later sync pass anyway.
 */
export async function addComment(circleId: string, postId: string, body: string): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) return;

  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No identity for this circle on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const commentId = generateUUID();
  const createdAt = Date.now();
  const encryptedMeta = buildAndEncryptLogEntry(
    EntryTypes.COMMENT,
    { commentId, postId, body: trimmed, createdAt },
    identity,
    current.key
  );

  await insertCommentAndEnqueue(
    {
      id: commentId,
      postId,
      authorPublicKey: bytesToHex(identity.publicKey),
      body: trimmed,
      createdAt,
    },
    {
      circleId,
      entryType: EntryTypes.COMMENT,
      localId: commentId,
      status: OutboxStatuses.pending,
      epoch: null,
      encryptedMeta,
    }
  );

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
}
