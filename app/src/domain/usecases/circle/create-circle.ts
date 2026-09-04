import { bytesToHex } from '@noble/curves/utils.js';

import {
  deriveAuthorityKeypair,
  deriveCircleIdentity,
  deriveCircleSealingKeypair,
  deriveWriteToken,
  generateContentKey,
  generateUUID,
  hashWriteToken,
  sealToPublicKey,
} from '@/services/crypto';
import { getProfile, insertCircle, insertMember, MemberRoles } from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { syncAccountManifestBestEffort } from '@/domain/usecases/account/account-manifest';
import { bootstrapCircle, appendEntry } from '@/services/relay';
import { getMasterSeed, saveCircleIdentity, saveCircleKeyMap } from '@/services/keystore';

export type CreateCircleInput = {
  name: string;
  /** Cover photo picked on the create screen, if any. */
  picture?: Uint8Array;
};

/**
 * Creates a circle and makes this device its first member, as `admin`.
 * Two required relay calls, not one (server/SYNC_DESIGN.md operation 1):
 * `bootstrapCircle` registers the control state, then `appendEntry` logs
 * the founder's own `member_added` using the token just registered. Both
 * propagate on failure rather than being swallowed — nothing about this
 * circle works until they succeed.
 *
 * Identity, sealing, and authority keys are all seed-derived (recoverable
 * from the phrase alone); the content key is freshly generated and sealed
 * to the founder's own sealing key so it's recoverable from the log too,
 * not just this device's Keychain.
 */
export async function createCircle(input: CreateCircleInput): Promise<{ id: string }> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed yet — onboarding must generate one before any circle exists.');

  const now = Date.now();
  const circleId = generateUUID();
  const syncId = generateUUID();
  const memberId = generateUUID();
  const identity = deriveCircleIdentity(masterSeed, circleId);
  const sealingKeypair = deriveCircleSealingKeypair(masterSeed, circleId);
  const authorityKeypair = deriveAuthorityKeypair(masterSeed, circleId);
  const contentKey = generateContentKey();
  const writeToken = deriveWriteToken(contentKey);

  await bootstrapCircle(syncId, authorityKeypair.publicKey, hashWriteToken(writeToken));

  const profile = await getProfile();
  const memberAddedEntry = buildAndEncryptLogEntry(
    EntryTypes.MEMBER_ADDED,
    {
      identityPublicKey: bytesToHex(identity.publicKey),
      encPublicKey: bytesToHex(sealingKeypair.publicKey),
      name: profile?.name ?? '',
      role: MemberRoles.admin,
      keyVersion: 1,
      sealedContentKey: bytesToHex(sealToPublicKey(contentKey, sealingKeypair.publicKey)),
    },
    identity,
    contentKey
  );
  await appendEntry(syncId, 'meta', generateUUID(), memberAddedEntry, 1, writeToken);

  await saveCircleIdentity(circleId, { ...identity, memberId });
  await saveCircleKeyMap(circleId, { 1: contentKey });

  await insertCircle({
    id: circleId,
    name: input.name,
    picture: input.picture ?? null,
    syncId,
    createdAt: now,
    leftAt: null,
    // Caught up through the entry this device just wrote itself —
    // nothing to gain by re-fetching what it already knows.
    metaCursor: 1,
    contentCursor: 0,
  });

  await insertMember({
    circleId,
    identityPublicKey: bytesToHex(identity.publicKey),
    encPublicKey: bytesToHex(sealingKeypair.publicKey),
    memberId,
    role: MemberRoles.admin,
    name: profile?.name ?? '',
    picture: profile?.picture ?? null,
    joinedAt: now,
  });

  await syncAccountManifestBestEffort();

  return { id: circleId };
}
