jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  getCircle,
  getMemberByPublicKey,
  getPendingOutboxEntries,
  initDatabase,
  MemberRoles,
  recordMemberAddedLocally,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { finishDeparture, finishPendingDepartures, leaveCircle } from '@/domain/usecases/circle/leave-circle';
import { buildAndEncryptLogEntry } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle, fetchEntries } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });
});

/** A circle founded here, with the founder's own append already accounted for. */
async function foundedCircle() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  jest.clearAllMocks();
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });
  return { circleId, identity, ownKey: bytesToHex(identity.publicKey), contentKey };
}

test('leaving pushes a self-signed member_removed to the meta namespace', async () => {
  const { circleId, ownKey } = await foundedCircle();

  await leaveCircle(circleId);
  // leaveCircle kicks the push fire-and-forget; settle it before asserting.
  await finishDeparture(circleId);

  const [namespace] = (appendEntry as jest.Mock).mock.calls.map((call) => [call[1]])[0];
  // A meta entry pushed to 'content' is discarded as an unknown type by
  // every device that fetches it — silently, and forever.
  expect(namespace).toBe('meta');
  expect(await getPendingOutboxEntries(circleId)).toHaveLength(0);
  expect((await getMemberByPublicKey(circleId, ownKey))?.removedAt).not.toBeNull();
  expect((await getCircle(circleId))?.leftAt).not.toBeNull();
});

test('leaving works offline — the circle is left now, the entry goes out later', async () => {
  const { circleId } = await foundedCircle();
  (appendEntry as jest.Mock).mockRejectedValue(new Error('offline'));

  await expect(leaveCircle(circleId)).resolves.toBeUndefined();

  // Left immediately as far as this device is concerned...
  expect((await getCircle(circleId))?.leftAt).not.toBeNull();
  // ...but the announcement is still queued, and the keys that sign its
  // push are deliberately still here.
  expect(await getPendingOutboxEntries(circleId)).toHaveLength(1);
  expect(await getCurrentContentKey(circleId)).not.toBeNull();

  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  await finishPendingDepartures();

  expect(await getPendingOutboxEntries(circleId)).toHaveLength(0);
  // Only once the circle has actually heard does the key material go.
  expect(await getCurrentContentKey(circleId)).toBeNull();
  expect(await getCircleIdentity(circleId)).toBeNull();
});

test('a failed push keeps the keys so the next pass can retry', async () => {
  const { circleId } = await foundedCircle();
  (appendEntry as jest.Mock).mockRejectedValue(new Error('offline'));

  await leaveCircle(circleId);
  await finishDeparture(circleId).catch(() => {});

  expect(await getPendingOutboxEntries(circleId)).toHaveLength(1);
  expect(await getCurrentContentKey(circleId)).not.toBeNull();
});

/** Appends this run has made for one circle — other tests in this file leave their own behind. */
async function appendsFor(circleId: string) {
  const { syncId } = (await getCircle(circleId))!;
  return (appendEntry as jest.Mock).mock.calls.filter((call) => call[0] === syncId);
}

test('finishPendingDepartures ignores a left circle with nothing queued', async () => {
  const { circleId } = await foundedCircle();
  await leaveCircle(circleId);
  await finishDeparture(circleId);
  jest.clearAllMocks();

  await finishPendingDepartures();

  expect(await appendsFor(circleId)).toHaveLength(0);
});

/**
 * The race that makes the post-pull key check load-bearing: an admin
 * removed this member while it was offline. That entry arrives on the
 * pull, tears the circle down, and takes the keys with it — so the queued
 * departure can no longer be signed, and no longer needs to be.
 */
test('a departure is abandoned if an admin got there first', async () => {
  const { circleId, ownKey, contentKey } = await foundedCircle();
  // A second admin, on the roster — the predicate won't accept a removal
  // from someone this device has never seen join.
  const admin = generateIdentity();
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(admin.publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.admin, name: 'Nadia', picture: null },
  });
  (appendEntry as jest.Mock).mockRejectedValue(new Error('offline'));
  await leaveCircle(circleId);
  await finishDeparture(circleId).catch(() => {});
  expect(await getPendingOutboxEntries(circleId)).toHaveLength(1);

  // Back online, and the log already says this member is gone. Drop the
  // failed attempt above so the assertion is about this pass only.
  (appendEntry as jest.Mock).mockClear();
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 3, receivedAt: Date.now() });
  (fetchEntries as jest.Mock).mockResolvedValue({
    entries: [
      {
        epoch: 2,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'member_removed',
          { identityPublicKey: ownKey, createdAt: 5_000 },
          admin,
          contentKey
        ),
      },
    ],
    currentEpoch: 2,
  });

  await finishPendingDepartures();

  expect(await getPendingOutboxEntries(circleId)).toHaveLength(0);
  // Never pushed: the entry could no longer be signed, and the removal it
  // was announcing had already happened.
  expect(await appendsFor(circleId)).toHaveLength(0);
  expect(await getCurrentContentKey(circleId)).toBeNull();
});

test('leaving a circle with no local row is refused rather than silently doing nothing', async () => {
  await expect(leaveCircle(generateUUID())).rejects.toThrow('No local circle row');
});
