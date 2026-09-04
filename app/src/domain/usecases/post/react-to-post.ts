import { bytesToHex } from '@noble/curves/utils.js';

import {
  getPostReactionSummary,
  hasReacted,
  OutboxStatuses,
  toggleReactionAndEnqueue,
  type NewOutboxEntry,
  type PostReaction,
  type ReactionSummary,
} from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';

/** Resolves this device's own circle identity public key, or null before it has one here. */
async function getOwnPublicKey(circleId: string): Promise<string | null> {
  const identity = await getCircleIdentity(circleId);
  return identity ? bytesToHex(identity.publicKey) : null;
}

/**
 * Adds this device's reaction if it isn't already there, or removes it if
 * it is — a single tap always flips the current state, matching how a
 * reaction chip actually gets used.
 *
 * Both directions append an entry, because the log is append-only: a
 * reaction can't be retracted, only superseded. So the entry carries
 * `reacted`, and replaying content in epoch order leaves whichever came
 * last as the final state on every device.
 */
export async function toggleReaction(circleId: string, postId: string, emoji: string): Promise<void> {
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No identity for this circle on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const authorPublicKey = bytesToHex(identity.publicKey);
  const reacted = !(await hasReacted(postId, authorPublicKey, emoji));
  const createdAt = Date.now();

  const reaction: PostReaction = { postId, authorPublicKey, emoji, createdAt };

  const outboxEntry: NewOutboxEntry = {
    circleId,
    entryType: EntryTypes.REACTION,
    // A fresh id per toggle: the relay dedupes on entryId, so reusing one
    // would make a re-reaction look like a retry of the removal and be
    // silently dropped.
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    encryptedMeta: buildAndEncryptLogEntry(
      EntryTypes.REACTION,
      { postId, emoji, reacted, createdAt },
      identity,
      current.key
    ),
  };

  await toggleReactionAndEnqueue(reaction, reacted, outboxEntry);

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
}

/** Reaction summary for a post, from this device's point of view. */
export async function getReactionsForPost(circleId: string, postId: string): Promise<ReactionSummary[]> {
  const publicKey = await getOwnPublicKey(circleId);
  if (!publicKey) return [];

  return getPostReactionSummary(postId, publicKey);
}
