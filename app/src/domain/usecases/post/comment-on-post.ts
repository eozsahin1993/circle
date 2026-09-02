import { generateUUID } from '@/services/crypto';
import { getProfile, insertComment } from '@/data/db';
import { getCircleIdentity } from '@/services/keystore';

/** Adds a comment as this device's own member identity in the circle. No-ops on an empty/whitespace-only body. */
export async function addComment(circleId: string, postId: string, body: string): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) return;

  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No identity for this circle on this device.');

  const profile = await getProfile();

  await insertComment({
    id: generateUUID(),
    postId,
    memberId: identity.memberId,
    authorName: profile?.name || 'You',
    body: trimmed,
    createdAt: Date.now(),
  });
}
