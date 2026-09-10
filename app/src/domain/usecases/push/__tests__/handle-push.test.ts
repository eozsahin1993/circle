jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/relay');
jest.mock('@/services/push-relay');
jest.mock('@/services/push-notification-channels');
jest.mock('@/services/image');

import { Buffer } from 'buffer';
import { bytesToHex } from '@noble/curves/utils.js';

import { initDatabase, MemberRoles, recordMemberAddedLocally } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { resetLocalDataForTesting } from '@/domain/usecases/dev-reset';
import { handlePush } from '@/domain/usecases/push/handle-push';
import { derivePushRoutingId, generateIdentity, generateUUID, type Keypair } from '@/services/crypto';
import { addCircleKeyVersion, getCircleIdentity, getCurrentContentKey, getMasterSeed, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  await resetLocalDataForTesting();
  await saveMasterSeed(new Uint8Array(16).fill(9));
});

/** A push as it arrives: the routing id, and the entry's own ciphertext. */
async function pushFor(circleId: string, type: string, author: Keypair, payload: object) {
  const current = (await getCurrentContentKey(circleId))!;
  const entry = buildAndEncryptLogEntry(type, payload, author, current.key);
  return {
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    payload: Buffer.from(entry).toString('base64'),
  };
}

test('a post becomes the author name and the circle', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;
  const entry = buildAndEncryptLogEntry(EntryTypes.POST, { postId: 'p1', createdAt: 1 }, identity, current.key);

  const notification = await handlePush({
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    payload: Buffer.from(entry).toString('base64'),
  });

  expect(notification).toMatchObject({ circleId, title: 'Family Circle', channelId: `circle-${circleId}` });
  expect(notification?.body).toContain('added a photo');
});

test('the author is named from the roster', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const marcus = generateIdentity();
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(marcus.publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Marcus', picture: null },
  });

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.COMMENT, marcus, { postId: 'p1', body: 'hi', createdAt: 1 }),
  );

  expect(notification?.body).toBe('Marcus commented');
});

/** Someone without the circle's key cannot make anything render. */
test('a payload this device cannot decrypt shows nothing', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  const notification = await handlePush({
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    payload: Buffer.from('not our ciphertext').toString('base64'),
  });

  expect(notification).toBeNull();
});

/** Key versions aren't named on the wire, so every held version is tried. */
test('an entry encrypted under an older key still decrypts', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const original = (await getCurrentContentKey(circleId))!;
  const entry = buildAndEncryptLogEntry(EntryTypes.POST, { postId: 'p1', createdAt: 1 }, identity, original.key);

  await addCircleKeyVersion(circleId, original.version + 1, new Uint8Array(32).fill(5));

  const notification = await handlePush({
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    payload: Buffer.from(entry).toString('base64'),
  });

  expect(notification?.body).toContain('added a photo');
});

test('a routing id for no circle here shows nothing', async () => {
  await createCircle({ name: 'Family Circle' });

  await expect(handlePush({ pushRoutingId: 'f'.repeat(64), payload: 'AAAA' })).resolves.toBeNull();
});

test.each([
  ['no routing id', { payload: 'AAAA' }],
  ['no payload', { pushRoutingId: 'f'.repeat(64) }],
  ['nothing at all', {}],
])('%s shows nothing', async (_label, data) => {
  await expect(handlePush(data)).resolves.toBeNull();
});

/** Reactions and posts interrupt; a rename or a key rotation must not. */
test('an entry type that should not interrupt shows nothing', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.CIRCLE_RENAMED, identity, { name: 'Nana House', createdAt: 1 }),
  );

  expect(notification).toBeNull();
});
