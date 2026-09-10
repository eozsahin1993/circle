jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { and, eq } from 'drizzle-orm';

import {
  getCircle,
  getCircleMembers,
  getMemberByPublicKey,
  getPendingOutboxEntries,
  initDatabase,
  insertMember,
  MemberRoles,
  recordMemberAddedLocally,
} from '@/data/db';
import { db } from '@/data/db/connection';
import { circleMembers } from '@/data/db/schema';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { finishDeparture, finishPendingDepartures, leaveCircle } from '@/domain/usecases/circle/leave-circle';
import { buildAndEncryptLogEntry } from '@/domain/usecases/circle/log-entry';
import { deriveAuthorityKeyProofMessage, generateIdentity, generateUUID, sign } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle, changeAuthority, fetchEntries } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  (changeAuthority as jest.Mock).mockResolvedValue({ epoch: 3, receivedAt: Date.now() });
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });
});

/** A circle founded here, with the founder's own append already accounted for. */
async function foundedCircle() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  jest.clearAllMocks();
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  (changeAuthority as jest.Mock).mockResolvedValue({ epoch: 3, receivedAt: Date.now() });
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

/** A published authority key plus the proof its owner holds it. */
function authorityClaim(identityPublicKey: string) {
  const authority = generateIdentity();
  return {
    authorityPublicKey: bytesToHex(authority.publicKey),
    authorityKeyProof: bytesToHex(sign(deriveAuthorityKeyProofMessage(identityPublicKey), authority.secretKey)),
  };
}

async function addMember(circleId: string, { joinedAt, publishedKey = true }: { joinedAt: number; publishedKey?: boolean }) {
  const identityPublicKey = bytesToHex(generateIdentity().publicKey);
  await insertMember({
    circleId,
    identityPublicKey,
    encPublicKey: 'cc',
    memberId: generateUUID(),
    authorityPublicKey: publishedKey ? authorityClaim(identityPublicKey).authorityPublicKey : '',
    role: MemberRoles.member,
    name: `Member ${joinedAt}`,
    picture: null,
    joinedAt,
    removedAt: null,
  });
  return identityPublicKey;
}

/**
 * The founder's authority key is the only one in the relay's set, so
 * walking out without handing it over leaves a circle nobody can ever
 * re-key, remove from, or promote in again.
 */
test('the last admin promotes a successor on the way out, before giving up their own key', async () => {
  const { circleId } = await foundedCircle();
  const oldest = await addMember(circleId, { joinedAt: 1_000 });
  await addMember(circleId, { joinedAt: 2_000 });

  await leaveCircle(circleId);
  await finishDeparture(circleId);

  const calls = (changeAuthority as jest.Mock).mock.calls.map(([change]) => change);
  // Order is load-bearing: the relay refuses a removal that would empty
  // the set, so the successor has to land first.
  expect(calls.map((change) => change.action)).toEqual(['add', 'remove']);

  const successor = (await getMemberByPublicKey(circleId, oldest))!;
  expect(bytesToHex(calls[0].targetAuthorityPublicKey)).toBe(successor.authorityPublicKey);
  // ...and the departure goes out behind both.
  expect((changeAuthority as jest.Mock).mock.invocationCallOrder[1]).toBeLessThan(
    (appendEntry as jest.Mock).mock.invocationCallOrder[0]
  );
});

/**
 * Being unable to leave is the worse failure, so a circle nobody can take
 * over is left ungovernable rather than the person left trapped in it.
 */
test('leaving still works when nobody has published a key to take over with', async () => {
  const { circleId, ownKey } = await foundedCircle();
  await addMember(circleId, { joinedAt: 1_000, publishedKey: false });

  await leaveCircle(circleId);
  await finishDeparture(circleId);

  const calls = (changeAuthority as jest.Mock).mock.calls.map(([change]) => change);
  expect(calls.filter((change) => change.action === 'add')).toHaveLength(0);
  expect((await getCircle(circleId))?.leftAt).not.toBeNull();
  expect((await getMemberByPublicKey(circleId, ownKey))?.removedAt).not.toBeNull();
});

/** Nobody is left behind to govern, so there is nothing to hand over. */
test('the last member out promotes nobody', async () => {
  const { circleId } = await foundedCircle();

  await leaveCircle(circleId);

  expect((changeAuthority as jest.Mock).mock.calls.filter(([change]) => change.action === 'add')).toHaveLength(0);
});

/** A circle that already has another admin the relay knows needs no handover. */
test('leaving alongside another admin promotes nobody', async () => {
  const { circleId } = await foundedCircle();
  const other = await addMember(circleId, { joinedAt: 1_000 });
  await db
    .update(circleMembers)
    .set({ role: MemberRoles.admin })
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.identityPublicKey, other)));

  await leaveCircle(circleId);

  const calls = (changeAuthority as jest.Mock).mock.calls.map(([change]) => change);
  expect(calls.map((change) => change.action)).toEqual(['remove']);
});

/**
 * The successor is chosen off the roster, so a stale one can hand the
 * circle to somebody who has already gone — and the relay accepts it,
 * because it reads no rosters. Nobody remaining could undo that.
 */
test('a successor who has already left is not chosen, once meta is caught up', async () => {
  const { circleId, identity, contentKey } = await foundedCircle();
  const oldest = await addMember(circleId, { joinedAt: 1_000 });
  const second = await addMember(circleId, { joinedAt: 2_000 });

  // The departure this device hasn't seen yet.
  (fetchEntries as jest.Mock).mockResolvedValue({
    entries: [
      {
        epoch: 2,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'member_removed',
          { identityPublicKey: oldest, createdAt: 3_000 },
          identity,
          contentKey
        ),
      },
    ],
    currentEpoch: 2,
  });

  await leaveCircle(circleId);

  const [promotion] = (changeAuthority as jest.Mock).mock.calls
    .map(([change]) => change)
    .filter((change) => change.action === 'add');
  expect(bytesToHex(promotion.targetAuthorityPublicKey)).toBe((await getMemberByPublicKey(circleId, second))!.authorityPublicKey);
});

/** Leaving can't depend on a connection, so a failed pull falls back to what this device already knows. */
test('a failed meta pull still leaves, using the roster this device already has', async () => {
  const { circleId } = await foundedCircle();
  const oldest = await addMember(circleId, { joinedAt: 1_000 });
  (fetchEntries as jest.Mock).mockRejectedValue(new Error('offline'));

  await leaveCircle(circleId);

  const [promotion] = (changeAuthority as jest.Mock).mock.calls
    .map(([change]) => change)
    .filter((change) => change.action === 'add');
  expect(bytesToHex(promotion.targetAuthorityPublicKey)).toBe((await getMemberByPublicKey(circleId, oldest))!.authorityPublicKey);
  expect((await getCircle(circleId))?.leftAt).not.toBeNull();
});
