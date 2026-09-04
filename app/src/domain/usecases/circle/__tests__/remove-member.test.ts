jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/services/relay');

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import {
  decrypt,
  deriveAuthorityKeypair,
  deriveCircleSealingKeypair,
  deriveRotateMessage,
  deriveWriteToken,
  generateIdentity,
  generateUUID,
  hashWriteToken,
  openSealedBox,
  verify,
} from '@/services/crypto';
import { getCircleIdentity, getCircleKeyMap, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { getCircle, getCircleMembers, initDatabase, insertMember, MemberRoles } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { removeMember } from '@/domain/usecases/circle/remove-member';
import { appendEntry, bootstrapCircle, fetchEntries, rotateLog } from '@/services/relay';

const MASTER_SEED = new Uint8Array(16);

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(MASTER_SEED);
});
beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (rotateLog as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  // removeMember calls pullMeta before acting; nothing new to pull here.
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });
});

async function makeCircleWithMember() {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });
  // createCircle's own bootstrap append shouldn't count toward removeMember's calls.
  jest.clearAllMocks();
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (rotateLog as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });

  const target = generateIdentity();
  const identityPublicKey = bytesToHex(target.publicKey);
  await insertMember({
    circleId,
    identityPublicKey,
    encPublicKey: 'cc',
    memberId: generateUUID(),
    role: MemberRoles.member,
    name: 'Marcus',
    picture: null,
    joinedAt: Date.now(),
    removedAt: null,
  });
  return { circleId, identityPublicKey };
}

test('removeMember excludes the target from the roster', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();

  await removeMember(circleId, identityPublicKey);

  const roster = await getCircleMembers(circleId);
  expect(roster.find((m) => m.identityPublicKey === identityPublicKey)).toBeUndefined();
});

test('removeMember appends a signed, verifiable member_removed meta entry before rotating', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();
  const circle = (await getCircle(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;

  await removeMember(circleId, identityPublicKey);

  expect(appendEntry).toHaveBeenCalledTimes(1);
  const [syncId, namespace, , encryptedMeta, keyVersion, writeToken] = (appendEntry as jest.Mock).mock.calls[0];
  expect(syncId).toBe(circle.syncId);
  expect(namespace).toBe('meta');
  expect(keyVersion).toBe(current.version);
  expect(writeToken).toEqual(deriveWriteToken(current.key));

  const envelope = JSON.parse(new TextDecoder().decode(decrypt(encryptedMeta, current.key)));
  expect(envelope.type).toBe('member_removed');
  expect(envelope.payload).toEqual({ identityPublicKey });
  const verified = verify(
    hexToBytes(envelope.signature),
    new TextEncoder().encode(JSON.stringify({ type: envelope.type, payload: envelope.payload })),
    hexToBytes(envelope.authorPubkey)
  );
  expect(verified).toBe(true);
});

test('removeMember calls rotateLog with a valid authority signature over the new write-token hash', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();
  const circle = (await getCircle(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;

  await removeMember(circleId, identityPublicKey);
  const after = (await getCurrentContentKey(circleId))!;

  expect(rotateLog).toHaveBeenCalledTimes(1);
  const [syncId, entryId, , currentKeyVersion, currentWriteToken, newWriteTokenHash, authorityPublicKey, signature] = (
    rotateLog as jest.Mock
  ).mock.calls[0];
  expect(syncId).toBe(circle.syncId);
  expect(currentKeyVersion).toBe(current.version);
  expect(currentWriteToken).toEqual(deriveWriteToken(current.key));
  expect(newWriteTokenHash).toBe(hashWriteToken(deriveWriteToken(after.key)));
  const authorityKeypair = deriveAuthorityKeypair(MASTER_SEED, circleId);
  expect(authorityPublicKey).toEqual(authorityKeypair.publicKey);
  expect(verify(signature, deriveRotateMessage(circle.syncId, entryId, newWriteTokenHash), authorityKeypair.publicKey)).toBe(true);
});

test('removeMember appends member_removed before calling rotateLog', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();
  const order: string[] = [];
  (appendEntry as jest.Mock).mockImplementation(async () => {
    order.push('appendEntry');
    return { epoch: 1, receivedAt: Date.now() };
  });
  (rotateLog as jest.Mock).mockImplementation(async () => {
    order.push('rotateLog');
    return { epoch: 2, receivedAt: Date.now() };
  });

  await removeMember(circleId, identityPublicKey);

  expect(order).toEqual(['appendEntry', 'rotateLog']);
});

test('removeMember rotates the content key locally, keeping the old version for history', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();
  const before = (await getCurrentContentKey(circleId))!;

  await removeMember(circleId, identityPublicKey);

  const after = (await getCurrentContentKey(circleId))!;
  expect(after.version).toBe(before.version + 1);
  expect(after.key).not.toEqual(before.key);
  const keyMap = await getCircleKeyMap(circleId);
  expect(keyMap?.[before.version]).toEqual(before.key);
});

test('removeMember rotates to a key the remaining member (itself) can open, but not the removed one', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();
  const founder = (await getCircleIdentity(circleId))!;
  const founderKey = bytesToHex(founder.publicKey);
  const before = (await getCurrentContentKey(circleId))!;

  await removeMember(circleId, identityPublicKey);
  const after = (await getCurrentContentKey(circleId))!;

  // rotateLog's second positional arg is entryId, third is the encrypted
  // payload — encrypted under the *old* key, since a remaining member
  // must be able to read it using a key they already have.
  const [, , rotationEntry] = (rotateLog as jest.Mock).mock.calls[0];
  const envelope = JSON.parse(new TextDecoder().decode(decrypt(rotationEntry, before.key)));
  expect(envelope.type).toBe('key_rotation');
  expect(envelope.payload.version).toBe(after.version);
  expect(envelope.payload.wraps[identityPublicKey]).toBeUndefined();

  const sealingKeypair = deriveCircleSealingKeypair(MASTER_SEED, circleId);
  const openedKey = openSealedBox(hexToBytes(envelope.payload.wraps[founderKey]), sealingKeypair);
  expect(openedKey).toEqual(after.key);
});

test('removeMember refuses to remove yourself', async () => {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });
  const founder = (await getCircleIdentity(circleId))!;

  await expect(removeMember(circleId, bytesToHex(founder.publicKey))).rejects.toThrow('Leave');

  expect(await getCircleMembers(circleId)).toHaveLength(1);
});

test('removeMember throws for a device with no identity in the circle', async () => {
  await expect(removeMember('not-a-real-circle-id', 'aa')).rejects.toThrow();
});
