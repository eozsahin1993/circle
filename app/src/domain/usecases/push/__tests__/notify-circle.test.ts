jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/relay');
jest.mock('@/services/push-relay');
jest.mock('@/services/image');

import { bytesToHex } from '@noble/curves/utils.js';

import { initDatabase, MemberRoles, recordMemberAddedLocally, setMemberPushRoutingId } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { resetLocalDataForTesting } from '@/domain/usecases/dev-reset';
import { notifyCircle } from '@/domain/usecases/push/notify-circle';
import { PushCategories } from '@/domain/usecases/push/push-registration';
import { derivePushFanoutToken, derivePushRoutingId, generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, getMasterSeed, saveMasterSeed } from '@/services/keystore';
import { sendPush } from '@/services/push-relay';
import { appendEntry, bootstrapCircle } from '@/services/relay';

const payload = new Uint8Array([7, 7, 7]);

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (sendPush as jest.Mock).mockResolvedValue({ delivered: 1, skipped: 0 });
  await resetLocalDataForTesting();
  await saveMasterSeed(new Uint8Array(16).fill(9));
});

/** Adds a member with a published routing id, and returns it. */
async function addMemberWithRouting(circleId: string, name: string): Promise<string> {
  const key = bytesToHex(generateIdentity().publicKey);
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: key,
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name, picture: null },
  });
  const pushRoutingId = `routing-${name}`;
  await setMemberPushRoutingId(circleId, key, pushRoutingId);
  return pushRoutingId;
}

test('targets every member who published a routing id', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const marcus = await addMemberWithRouting(circleId, 'marcus');
  const nadia = await addMemberWithRouting(circleId, 'nadia');

  await notifyCircle(circleId, PushCategories.newPhoto, payload);

  const [routingIds, fanoutToken, category, sentPayload] = (sendPush as jest.Mock).mock.calls[0];
  expect([...routingIds].sort()).toEqual([marcus, nadia].sort());
  expect(fanoutToken).toEqual(derivePushFanoutToken((await getCurrentContentKey(circleId))!.key));
  expect(category).toBe(PushCategories.newPhoto);
  expect(sentPayload).toBe(payload);
});

/** Your devices share one routing id, so excluding it silences all of them. */
test('never targets the sender', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  await setMemberPushRoutingId(circleId, bytesToHex(identity.publicKey), derivePushRoutingId((await getMasterSeed())!, circleId));
  const marcus = await addMemberWithRouting(circleId, 'marcus');

  await notifyCircle(circleId, PushCategories.newPhoto, payload);

  expect((sendPush as jest.Mock).mock.calls[0][0]).toEqual([marcus]);
});

/** A member who never opted into notifications simply isn't targetable. */
test('skips members with no routing id', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(generateIdentity().publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Quiet', picture: null },
  });

  await notifyCircle(circleId, PushCategories.newPhoto, payload);

  expect(sendPush).not.toHaveBeenCalled();
});

test('a circle with nobody to notify sends nothing', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  await notifyCircle(circleId, PushCategories.commentOrReaction, payload);

  expect(sendPush).not.toHaveBeenCalled();
});
