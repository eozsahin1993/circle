import { Buffer } from 'buffer';
import { getPermissionsAsync } from 'expo-notifications';

import { getAllCircles } from '@/data/db';
import { getDevicePushToken } from '@/services/push/tokens';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { PushCategories } from '@/domain/usecases/push/push-categories';
import { derivePushFanoutToken, derivePushRoutingId, generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, getMasterSeed } from '@/services/keystore';

/**
 * DEV-ONLY: logs a `curl` against the relay's /push/send that targets
 * this device's own routing id — encrypted and signed with its own keys,
 * which never leave the Keychain, so no external tool can build this.
 * Self-targeting on purpose: the normal fanout excludes the sender, and
 * this exists to test the receive path (real APNs into the simulator,
 * the iOS extension) without a second account. Only ever call this from
 * a `__DEV__`-gated UI action.
 */
/** Why launch registration may have silently done nothing — every quiet exit in enablePushEverywhere, made loud. */
async function logPushRegistrationState(): Promise<void> {
  const permissions = await getPermissionsAsync();
  console.log(`Push state: permission granted=${permissions.granted} canAskAgain=${permissions.canAskAgain}`);

  const device = await Promise.race([
    getDevicePushToken(),
    new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 5000)),
  ]);
  if (device === 'timed out') {
    console.log('Push state: getDevicePushTokenAsync never resolved (5s) — the native token callback is not reaching JS');
  } else {
    console.log(`Push state: token=${device ? `${device.platform}:${device.pushToken.slice(0, 12)}…` : 'null'}`);
  }

  for (const circle of await getAllCircles()) {
    console.log(`Push state: circle "${circle.name}" pushSilenced=${circle.pushSilenced}`);
  }
}

export async function logTestPushPayload(): Promise<void> {
  await logPushRegistrationState();

  const masterSeed = await getMasterSeed();
  const circle = (await getAllCircles())[0];
  if (!masterSeed || !circle) {
    console.log('Test push: no seed or no circle on this device yet');
    return;
  }
  const identity = await getCircleIdentity(circle.id);
  const current = await getCurrentContentKey(circle.id);
  if (!identity || !current) {
    console.log(`Test push: no identity or content key for circle ${circle.id}`);
    return;
  }

  const entry = buildAndEncryptLogEntry(
    EntryTypes.COMMENT,
    { commentId: generateUUID(), postId: generateUUID(), body: 'push pipeline test', createdAt: Date.now() },
    identity,
    current.key,
  );

  const body = {
    pushRoutingIds: [derivePushRoutingId(masterSeed, circle.id)],
    pushFanoutToken: Buffer.from(derivePushFanoutToken(current.key)).toString('base64'),
    category: PushCategories.comment,
    keyVersion: current.version,
    payload: Buffer.from(entry).toString('base64'),
  };
  console.log(`Test push for "${circle.name}" — run:`);
  console.log(
    `curl -s -X POST http://localhost:8090/v1/push/send -H 'Content-Type: application/json' -d '${JSON.stringify(body)}'`,
  );
}
