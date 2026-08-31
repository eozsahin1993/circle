import { addReaction, getPostReactionSummary, hasReacted, removeReaction, type ReactionSummary } from '@/data/db';
import { getCircleIdentity } from '@/services/keystore';

/** Resolves this device's own memberId for a circle, or null before it has an identity there. */
async function getOwnMemberId(circleId: string): Promise<string | null> {
  const identity = await getCircleIdentity(circleId);
  return identity?.memberId ?? null;
}

/**
 * Adds this device's reaction if it isn't already there, or removes it if
 * it is — a single tap always flips the current state, matching how a
 * reaction chip actually gets used.
 */
export async function toggleReaction(circleId: string, postId: string, emoji: string): Promise<void> {
  const memberId = await getOwnMemberId(circleId);
  if (!memberId) throw new Error('No identity for this circle on this device.');

  if (await hasReacted(postId, memberId, emoji)) {
    await removeReaction(postId, memberId, emoji);
  } else {
    await addReaction({ postId, memberId, emoji, createdAt: Date.now() });
  }
}

/** Reaction summary for a post, from this device's point of view. */
export async function getReactionsForPost(circleId: string, postId: string): Promise<ReactionSummary[]> {
  const memberId = await getOwnMemberId(circleId);
  if (!memberId) return [];

  return getPostReactionSummary(postId, memberId);
}
