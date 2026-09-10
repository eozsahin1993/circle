import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleMembers } from '@/data/db';
import type { PushCategory } from '@/domain/usecases/push/push-registration';
import { derivePushFanoutToken } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';
import { sendPush } from '@/services/push-relay';

/**
 * Asks the relay to notify a circle about an entry that was just
 * appended — see server/PUSH_DESIGN.md.
 *
 * `payload` is the entry's own ciphertext, forwarded untouched: the relay
 * cannot read it, and the receiving device decrypts and writes the
 * notification text itself.
 */
export async function notifyCircle(circleId: string, category: PushCategory, payload: Uint8Array): Promise<void> {
  const identity = await getCircleIdentity(circleId);
  const current = await getCurrentContentKey(circleId);
  if (!identity || !current) return;

  const members = await getCircleMembers(circleId);
  // Your devices share one routing id, so excluding it silences all of
  // them — which is what you want for something you just posted.
  const ownPublicKey = bytesToHex(identity.publicKey);
  const routingIds = members
    .filter((member) => member.identityPublicKey !== ownPublicKey && member.pushRoutingId !== '')
    .map((member) => member.pushRoutingId);
  if (routingIds.length === 0) return;

  // Shuffled: sending in roster order would leak the roster's ordering
  // across posts, which is stable and therefore correlatable.
  await sendPush(shuffle(routingIds), derivePushFanoutToken(current.key), category, payload);
}

/**
 * Best-effort wrapper — a notification that doesn't go out must never fail
 * the post that triggered it. Fire without awaiting.
 */
export function notifyCircleBestEffort(circleId: string, category: PushCategory, payload: Uint8Array): void {
  notifyCircle(circleId, category, payload).catch((err) => console.error('Failed to notify circle', err));
}

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}
