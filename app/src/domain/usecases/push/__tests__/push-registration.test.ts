jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/relay');
jest.mock('@/services/push-relay');
jest.mock('@/services/image');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  getCircleMembers,
  getPendingOutboxEntries,
  initDatabase,
  setMemberPushRoutingId,
} from '@/data/db';
import { EntryTypes } from '@/domain/usecases/circle/log-entry';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { resetLocalDataForTesting } from '@/domain/usecases/dev-reset';
import {
  PushCategories,
  registerPushForCircle,
  silenceCircle,
  unregisterDeviceForCircle,
} from '@/domain/usecases/push/push-registration';
import { derivePushFanoutHash, derivePushFanoutToken, derivePushRoutingId } from '@/services/crypto';
import {
  deleteCircleKeys,
  getCircleIdentity,
  getCurrentContentKey,
  getMasterSeed,
  saveMasterSeed,
} from '@/services/keystore';
import { deletePushDevice, deletePushRouting, putPushDevice, putPushPrefs } from '@/services/push-relay';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { appendEntry, bootstrapCircle } from '@/services/relay';

const registration = {
  pushToken: new Uint8Array([1, 2, 3]),
  platform: 'android' as const,
  categories: [PushCategories.newPost, PushCategories.comment],
};

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  for (const fn of [putPushPrefs, putPushDevice, deletePushDevice, deletePushRouting]) {
    (fn as jest.Mock).mockResolvedValue(undefined);
  }
  await resetLocalDataForTesting();
  await saveMasterSeed(new Uint8Array(16).fill(9));
});

test('registers prefs and this device against the derived routing id', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const seed = (await getMasterSeed())!;
  const current = (await getCurrentContentKey(circleId))!;

  await registerPushForCircle(circleId, registration);

  const pushRoutingId = derivePushRoutingId(seed, circleId);
  const [prefsRoutingId, fanoutHash, categories, keyVersion] = (putPushPrefs as jest.Mock).mock.calls[0];
  expect(prefsRoutingId).toBe(pushRoutingId);
  expect(fanoutHash).toEqual(derivePushFanoutHash(derivePushFanoutToken(current.key), pushRoutingId));
  expect(categories).toEqual([0, 1]);
  expect(keyVersion).toBe(current.version);

  const [deviceRoutingId, , pushToken, platform, enabled] = (putPushDevice as jest.Mock).mock.calls[0];
  expect(deviceRoutingId).toBe(pushRoutingId);
  expect(pushToken).toEqual(registration.pushToken);
  expect(platform).toBe('android');
  expect(enabled).toBe(true);
});

/** The relay never sees the token itself, only a hash it can compare. */
test('the fanout token stays on the device', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const current = (await getCurrentContentKey(circleId))!;

  await registerPushForCircle(circleId, registration);

  const sent = JSON.stringify((putPushPrefs as jest.Mock).mock.calls[0]);
  expect(sent).not.toContain(bytesToHex(derivePushFanoutToken(current.key)));
});

/**
 * A member who joined before push existed has no routing id on their
 * roster row, so enabling it has to announce one.
 */
test('announces a routing id when the roster does not have one yet', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const ownKey = bytesToHex(identity.publicKey);
  await setMemberPushRoutingId(circleId, ownKey, '');

  await registerPushForCircle(circleId, registration);

  const queued = (await getPendingOutboxEntries(circleId)).filter(
    (entry) => entry.entryType === EntryTypes.PUSH_ENABLED,
  );
  expect(queued).toHaveLength(1);

  const own = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === ownKey);
  expect(own?.pushRoutingId).toBe(derivePushRoutingId((await getMasterSeed())!, circleId));
});

/** createCircle and completeJoin already stamp it, so the usual path is silent. */
test('announces nothing when the roster already agrees', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  await registerPushForCircle(circleId, registration);
  await registerPushForCircle(circleId, registration);

  expect(await getPendingOutboxEntries(circleId)).toHaveLength(0);
  // The relay rows are still refreshed, since a token or category may have
  // changed even when the routing id hasn't.
  expect(putPushDevice as jest.Mock).toHaveBeenCalledTimes(2);
});

test('a circle with no content key registers nothing', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await deleteCircleKeys(circleId);

  await registerPushForCircle(circleId, registration);

  expect(putPushPrefs).not.toHaveBeenCalled();
});

test('unregistering this device leaves the routing id in place', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await registerPushForCircle(circleId, registration);

  await unregisterDeviceForCircle(circleId);

  expect(deletePushDevice).toHaveBeenCalledTimes(1);
  expect(deletePushRouting).not.toHaveBeenCalled();
});

test('silencing a circle removes the routing id outright', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  await silenceCircle(circleId);

  expect(deletePushRouting).toHaveBeenCalledWith(derivePushRoutingId((await getMasterSeed())!, circleId));
});

describe('the derivations', () => {
  test('a routing id is the same for one seed and different per circle', () => {
    const seed = new Uint8Array(16).fill(9);
    expect(derivePushRoutingId(seed, 'circle-1')).toBe(derivePushRoutingId(seed, 'circle-1'));
    expect(derivePushRoutingId(seed, 'circle-1')).not.toBe(derivePushRoutingId(seed, 'circle-2'));
    expect(derivePushRoutingId(seed, 'circle-1')).not.toBe(derivePushRoutingId(new Uint8Array(16).fill(1), 'circle-1'));
  });

  /** Salting is what stops a circle's rows sharing one clusterable value. */
  test('a fanout hash is bound to its routing id', () => {
    const token = derivePushFanoutToken(new Uint8Array(32).fill(4));
    expect(derivePushFanoutHash(token, 'push-routing-a')).not.toEqual(derivePushFanoutHash(token, 'push-routing-b'));
  });

  /** Removal rotates the content key, which is what revokes push. */
  test('a fanout token follows the content key', () => {
    expect(derivePushFanoutToken(new Uint8Array(32).fill(1))).not.toEqual(derivePushFanoutToken(new Uint8Array(32).fill(2)));
  });
});
