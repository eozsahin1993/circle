import { bytesToHex } from '@noble/curves/utils.js';

import { generateCircleSecret, generateIdentity, generateUUID } from '@/services/crypto';
import { getProfile, insertCircle, insertMember, MemberRoles } from '@/data/db';
import { saveCircleIdentity, saveCircleSecret } from '@/services/keystore';

export type CreateCircleInput = {
  name: string;
  /** Cover photo picked on the create screen, if any. */
  picture?: Uint8Array;
};

/**
 * Creates a circle and makes this device its first member — as `admin`,
 * since the founder is the only member who exists until they invite anyone
 * else. A fresh per-circle identity (never reused across circles — see
 * `generateIdentity`) plus a fresh shared secret, both persisted to the
 * Keychain, then the circle and roster rows themselves. The device
 * profile's name/picture become this member's roster entry.
 */
export async function createCircle(input: CreateCircleInput): Promise<{ id: string }> {
  const now = Date.now();
  const circleId = generateUUID();
  const memberId = generateUUID();
  const identity = generateIdentity();
  const secret = generateCircleSecret();

  await saveCircleIdentity(circleId, { ...identity, memberId });
  await saveCircleSecret(circleId, secret);

  await insertCircle({
    id: circleId,
    name: input.name,
    picture: input.picture ?? null,
    createdAt: now,
    leftAt: null,
  });

  const profile = await getProfile();
  await insertMember({
    circleId,
    publicKey: bytesToHex(identity.publicKey),
    memberId,
    role: MemberRoles.admin,
    name: profile?.name ?? '',
    picture: profile?.picture ?? null,
    joinedAt: now,
  });

  return { id: circleId };
}
