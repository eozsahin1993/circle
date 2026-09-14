import { getDevicePushTokenAsync, getPermissionsAsync, requestPermissionsAsync } from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Notification permission and this device's push token.
 *
 * `getDevicePushTokenAsync`, not `getExpoPushTokenAsync`: the relay talks
 * to FCM and APNs directly, so it needs the platform's own token. An Expo
 * push token would route delivery through Expo's servers, adding a party
 * that would see who is notified and when.
 */

/**
 * Asks once, if it hasn't been asked. Returns whether notifications are
 * allowed — a refusal is a normal outcome, not an error.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  const existing = await getPermissionsAsync();
  if (existing.granted) return true;
  // Asking again after a denial does nothing on either platform; the OS
  // only shows the prompt once and the user has to go to settings.
  if (!existing.canAskAgain) return false;

  return (await requestPermissionsAsync()).granted;
}

export type DevicePushToken = { pushToken: string; platform: 'ios' | 'android' };

/**
 * Null when permission hasn't been granted, or on a platform with no push.
 *
 * `ask` decides whether a refusal is final: launch passes false, because
 * the OS shows its prompt once and a cold start is the worst moment to
 * spend it — nothing on screen explains what is being asked for. Joining or
 * creating a circle passes true, where the reason is obvious.
 */
export async function getDevicePushToken({ ask = false } = {}): Promise<DevicePushToken | null> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;

  const granted = ask ? await ensureNotificationPermission() : (await getPermissionsAsync()).granted;
  if (!granted) return null;

  const { data } = await getDevicePushTokenAsync();
  // FCM and APNs both hand back a string here; the union covers web, which
  // this never runs on.
  return typeof data === 'string' ? { pushToken: data, platform: Platform.OS } : null;
}
