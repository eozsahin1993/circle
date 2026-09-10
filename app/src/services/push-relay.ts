import { Buffer } from 'buffer';

import { authorizedFetch, baseUrl } from '@/services/relay';

/**
 * The relay's push routing endpoints — see server/PUSH_DESIGN.md.
 *
 * Registration is session-gated like everything else. `sendPush` is not,
 * and deliberately: an authenticated send would arrive beside an
 * identified poster, letting the relay solve a circle's membership by
 * elimination. It authorizes on the fanout token instead.
 */

/** Writes this account's control row for one circle — categories and the fanout hash. */
export async function putPushPrefs(
  pushRoutingId: string,
  pushFanoutHash: Uint8Array,
  categories: number[],
  keyVersion: number,
): Promise<void> {
  const response = await authorizedFetch(`/v1/push/${pushRoutingId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pushFanoutHash: Buffer.from(pushFanoutHash).toString('base64'),
      categories,
      keyVersion,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to store push preferences: ${response.status}`);
  }
}

/** Registers this device's push token under a routing id. */
export async function putPushDevice(
  pushRoutingId: string,
  deviceId: string,
  pushToken: Uint8Array,
  platform: 'ios' | 'android',
  enabled: boolean,
): Promise<void> {
  const response = await authorizedFetch(`/v1/push/${pushRoutingId}/devices/${deviceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pushToken: Buffer.from(pushToken).toString('base64'), platform, enabled }),
  });
  if (!response.ok) {
    throw new Error(`Failed to register push device: ${response.status}`);
  }
}

/** Removes one device's row. Idempotent. */
export async function deletePushDevice(pushRoutingId: string, deviceId: string): Promise<void> {
  const response = await authorizedFetch(`/v1/push/${pushRoutingId}/devices/${deviceId}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`Failed to remove push device: ${response.status}`);
  }
}

/** Silences a circle outright — prefs and every device row. Idempotent. */
export async function deletePushRouting(pushRoutingId: string): Promise<void> {
  const response = await authorizedFetch(`/v1/push/${pushRoutingId}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`Failed to silence push for this circle: ${response.status}`);
  }
}

export type FanoutResult = { delivered: number; skipped: number };

/**
 * Fans a notification out to a circle. Unauthenticated on purpose — see
 * this file's header. `payload` is the entry's own ciphertext.
 */
export async function sendPush(
  pushRoutingIds: string[],
  pushFanoutToken: Uint8Array,
  category: number,
  payload: Uint8Array,
): Promise<FanoutResult> {
  const response = await fetch(`${baseUrl()}/v1/push/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pushRoutingIds,
      pushFanoutToken: Buffer.from(pushFanoutToken).toString('base64'),
      category,
      payload: Buffer.from(payload).toString('base64'),
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to send push: ${response.status}`);
  }
  return (await response.json()) as FanoutResult;
}
