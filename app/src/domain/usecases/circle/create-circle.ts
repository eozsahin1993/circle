import { bytesToHex } from '@noble/curves/utils.js';

import { deriveCircleIdentity, generateCircleSecret, generateUUID } from '@/services/crypto';
import { getProfile, insertCircle, insertMember, MemberRoles } from '@/data/db';
import { syncAccountManifestBestEffort } from '@/domain/usecases/account/account-manifest';
import { getMasterSeed, saveCircleIdentity, saveCircleSecret } from '@/services/keystore';

export type CreateCircleInput = {
  name: string;
  /** Cover photo picked on the create screen, if any. */
  picture?: Uint8Array;
};

/**
 * Creates a circle and makes this device its first member — as `admin`,
 * since the founder is the only member who exists until they invite anyone
 * else. The per-circle identity is derived from the device's master seed
 * (see `deriveCircleIdentity` — domain-separated per circleId, same as
 * the old `generateIdentity`'s never-reuse-across-circles rule, but now
 * recoverable from the seed alone) plus a fresh shared secret, both
 * persisted to the Keychain, then the circle and roster rows themselves.
 * The device profile's name/picture become this member's roster entry.
 */
export async function createCircle(input: CreateCircleInput): Promise<{ id: string }> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed yet — onboarding must generate one before any circle exists.');

  const now = Date.now();
  const circleId = generateUUID();
  const memberId = generateUUID();
  const identity = deriveCircleIdentity(masterSeed, circleId);
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

  await syncAccountManifestBestEffort();

  return { id: circleId };
}
