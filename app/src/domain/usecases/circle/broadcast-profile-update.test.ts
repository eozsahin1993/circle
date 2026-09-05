jest.mock('@/services/relay');
jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/image');

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { decrypt, generateUUID, verify } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { getCircleMembers, getPendingOutboxEntries, initDatabase, insertCircle } from '@/data/db';
import { broadcastProfileUpdate } from '@/domain/usecases/circle/broadcast-profile-update';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { compressToThumbnail } from '@/services/image';
import { appendEntry, bootstrapCircle } from '@/services/relay';

// The real compressToThumbnail runs actual image-decoding native modules —
// tests pass plain byte arrays as "pictures", not real image files, so it's
// mocked to just echo them back rather than crash trying to decode one.
beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (compressToThumbnail as jest.Mock).mockImplementation((bytes: Uint8Array) => Promise.resolve(bytes));
});

test('queues a signed, verifiable profile_update entry for every circle this device is in', async () => {
  const { id: circleA } = await createCircle({ name: 'Family' });
  const { id: circleB } = await createCircle({ name: 'Friends' });

  await broadcastProfileUpdate('New Name', new Uint8Array([9, 9, 9]));

  for (const circleId of [circleA, circleB]) {
    const current = (await getCurrentContentKey(circleId))!;
    const [queued] = await getPendingOutboxEntries(circleId);
    expect(queued.entryType).toBe('profile_update');

    const envelope = JSON.parse(new TextDecoder().decode(decrypt(queued.encryptedMeta, current.key)));
    expect(envelope.type).toBe('profile_update');
    expect(envelope.payload.name).toBe('New Name');
    expect(new Uint8Array(Buffer.from(envelope.payload.picture, 'base64'))).toEqual(new Uint8Array([9, 9, 9]));

    const identity = (await getCircleIdentity(circleId))!;
    expect(envelope.authorPubkey).toBe(bytesToHex(identity.publicKey));
    const verified = verify(
      hexToBytes(envelope.signature),
      new TextEncoder().encode(JSON.stringify({ type: envelope.type, payload: envelope.payload })),
      identity.publicKey
    );
    expect(verified).toBe(true);
  }
});

test('updates the local roster row immediately, not just the outbox', async () => {
  const { id: circleId } = await createCircle({ name: 'Family' });
  const identity = (await getCircleIdentity(circleId))!;

  await broadcastProfileUpdate('New Name', new Uint8Array([9, 9, 9]));

  const self = (await getCircleMembers(circleId)).find((m) => m.identityPublicKey === bytesToHex(identity.publicKey));
  expect(self?.name).toBe('New Name');
  expect(self?.picture).toEqual(new Uint8Array([9, 9, 9]));
});

test('kicks off a drain for every circle', async () => {
  const { id: circleA } = await createCircle({ name: 'Family' });
  const { id: circleB } = await createCircle({ name: 'Friends' });

  await broadcastProfileUpdate('New Name', null);

  expect(drainOutbox).toHaveBeenCalledWith(circleA);
  expect(drainOutbox).toHaveBeenCalledWith(circleB);
});

test('a null picture broadcasts with no picture field, not a cleared-but-present one', async () => {
  const { id: circleId } = await createCircle({ name: 'Family' });
  const current = (await getCurrentContentKey(circleId))!;

  await broadcastProfileUpdate('New Name', null);

  const [queued] = await getPendingOutboxEntries(circleId);
  const envelope = JSON.parse(new TextDecoder().decode(decrypt(queued.encryptedMeta, current.key)));
  expect(envelope.payload.picture).toBeUndefined();
});

test('a circle with no identity/content key on this device is skipped without blocking the others', async () => {
  const { id: circleA } = await createCircle({ name: 'Family' });
  // A local circle row with no matching keystore entries — shouldn't
  // happen in practice, but is the realistic shape of "this device has no
  // keys for this circle" without mocking getCircleIdentity itself.
  await insertCircle({
    id: generateUUID(),
    name: 'Keyless',
    picture: null,
    syncId: generateUUID(),
    createdAt: Date.now(),
    leftAt: null,
    metaCursor: 0,
    contentCursor: 0,
  });

  await expect(broadcastProfileUpdate('New Name', null)).resolves.toBeUndefined();

  const [queuedA] = await getPendingOutboxEntries(circleA);
  expect(queuedA).toBeDefined();
});
