jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/services/relay');

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { decrypt, generateIdentity, generateUUID, verify } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { getCircleMembers, getPendingOutboxEntries, initDatabase, insertMember, MemberRoles } from '@/data/db';
import { setMemberRole } from '@/domain/usecases/circle/change-member-role';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.clearAllMocks();
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

async function makeCircleWithMember() {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

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

test('setMemberRole promotes a plain member to admin locally', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();

  await setMemberRole(circleId, identityPublicKey, 'admin');

  const member = (await getCircleMembers(circleId)).find((m) => m.identityPublicKey === identityPublicKey);
  expect(member?.role).toBe('admin');
});

test('setMemberRole demotes an admin to a plain member locally', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();
  await setMemberRole(circleId, identityPublicKey, 'admin');

  await setMemberRole(circleId, identityPublicKey, 'member');

  const member = (await getCircleMembers(circleId)).find((m) => m.identityPublicKey === identityPublicKey);
  expect(member?.role).toBe('member');
});

test('setMemberRole queues a signed, verifiable role_change meta entry', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();
  const current = (await getCurrentContentKey(circleId))!;

  await setMemberRole(circleId, identityPublicKey, 'admin');

  const pending = await getPendingOutboxEntries(circleId);
  const queued = pending.find((entry) => entry.entryType === 'role_change');
  expect(queued).toBeDefined();

  const envelope = JSON.parse(new TextDecoder().decode(decrypt(queued!.encryptedMeta, current.key)));
  expect(envelope.type).toBe('role_change');
  expect(envelope.payload).toEqual({ identityPublicKey, role: 'admin' });
  const verified = verify(
    hexToBytes(envelope.signature),
    new TextEncoder().encode(JSON.stringify({ type: envelope.type, payload: envelope.payload })),
    hexToBytes(envelope.authorPubkey)
  );
  expect(verified).toBe(true);
});

test('setMemberRole refuses to change your own role', async () => {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });
  const founder = (await getCircleIdentity(circleId))!;

  await expect(setMemberRole(circleId, bytesToHex(founder.publicKey), 'member')).rejects.toThrow("own role");
});

test('setMemberRole throws for a device with no identity in the circle', async () => {
  await expect(setMemberRole('not-a-real-circle-id', 'aa', 'admin')).rejects.toThrow();
});
