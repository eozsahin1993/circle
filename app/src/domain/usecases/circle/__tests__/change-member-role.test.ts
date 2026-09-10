jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/services/relay');

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { decrypt, generateIdentity, generateUUID, sign, verify, deriveAuthorityKeyProofMessage } from '@/services/crypto';
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

/** A circle plus one other member, carrying the authority key their `member_added` would have published. */
async function makeCircleWithMember() {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

  const target = generateIdentity();
  const authority = generateIdentity();
  const identityPublicKey = bytesToHex(target.publicKey);
  await insertMember({
    circleId,
    identityPublicKey,
    encPublicKey: 'cc',
    memberId: generateUUID(),
    authorityPublicKey: bytesToHex(authority.publicKey),
    role: MemberRoles.member,
    name: 'Marcus',
    picture: null,
    joinedAt: Date.now(),
    removedAt: null,
  });
  return { circleId, identityPublicKey, authorityPublicKey: bytesToHex(authority.publicKey) };
}

test('setMemberRole queues a promotion tagged to move the relay authority set', async () => {
  const { circleId, identityPublicKey, authorityPublicKey } = await makeCircleWithMember();

  await setMemberRole(circleId, identityPublicKey, 'admin');

  const queued = (await getPendingOutboxEntries(circleId)).find((entry) => entry.entryType === 'role_change');
  expect(queued).toMatchObject({ authorityAction: 'add', authorityTargetKey: authorityPublicKey });
});

// The bug: a promotion the relay never heard about produced an admin
// every client honoured and the relay rejected.
test('a promotion queues a signed, verifiable role_change', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();
  const current = (await getCurrentContentKey(circleId))!;

  await setMemberRole(circleId, identityPublicKey, 'admin');

  const queued = (await getPendingOutboxEntries(circleId)).find((entry) => entry.entryType === 'role_change')!;
  const envelope = JSON.parse(new TextDecoder().decode(decrypt(queued.encryptedMeta, current.key)));
  expect(envelope.type).toBe('role_change');
  expect(envelope.payload).toMatchObject({ identityPublicKey, role: 'admin' });
  expect(typeof envelope.payload.createdAt).toBe('number');
  const verified = verify(
    hexToBytes(envelope.signature),
    new TextEncoder().encode(JSON.stringify({ type: envelope.type, payload: envelope.payload })),
    hexToBytes(envelope.authorPubkey)
  );
  expect(verified).toBe(true);
});

/**
 * The relay can genuinely refuse an authority change, so the roster must
 * not claim it happened until the entry comes back — otherwise the badge
 * is exactly the lie this whole path exists to stop telling.
 */
test('setMemberRole changes nothing locally until the entry replays back', async () => {
  const { circleId, identityPublicKey } = await makeCircleWithMember();

  await setMemberRole(circleId, identityPublicKey, 'admin');

  const member = (await getCircleMembers(circleId)).find((m) => m.identityPublicKey === identityPublicKey);
  expect(member?.role).toBe('member');
});

test('setMemberRole refuses to change your own role', async () => {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });
  const founder = (await getCircleIdentity(circleId))!;

  await expect(setMemberRole(circleId, bytesToHex(founder.publicKey), 'member')).rejects.toThrow('own role');
});

test('setMemberRole throws for a device with no identity in the circle', async () => {
  await expect(setMemberRole('not-a-real-circle-id', 'aa', 'admin')).rejects.toThrow();
});

/** A key nobody can prove they hold is worth nothing — see `provenAuthorityKey`. */
test('the published authority key carries a proof its owner holds it', async () => {
  const authority = generateIdentity();
  const identityPublicKey = bytesToHex(generateIdentity().publicKey);
  const proof = sign(deriveAuthorityKeyProofMessage(identityPublicKey), authority.secretKey);

  expect(verify(proof, deriveAuthorityKeyProofMessage(identityPublicKey), authority.publicKey)).toBe(true);
  expect(verify(proof, deriveAuthorityKeyProofMessage('deadbeef'), authority.publicKey)).toBe(false);
});
