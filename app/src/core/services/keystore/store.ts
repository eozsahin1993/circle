import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { APP_GROUP } from '@/core/services/app-group';

/**
 * iOS secrets live in the shared App Group keychain so the notification
 * extension can read them — AFTER_FIRST_UNLOCK, because it runs while the
 * phone is locked and the default WHEN_UNLOCKED is unreadable exactly then.
 */
const sharedOptions: SecureStore.SecureStoreOptions | undefined =
  Platform.OS === 'ios' ? { accessGroup: APP_GROUP, keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK } : undefined;

export async function getSecret(key: string): Promise<string | null> {
  if (!sharedOptions) return SecureStore.getItemAsync(key);

  const shared = await SecureStore.getItemAsync(key, sharedOptions);
  if (shared !== null) return shared;

  // Pre-App-Group installs hold their secrets in the app's own keychain
  // group; copy forward on first read. The old item is deliberately left
  // behind: a delete query without an accessGroup matches every group —
  // including the copy just written.
  const legacy = await SecureStore.getItemAsync(key);
  if (legacy !== null) await SecureStore.setItemAsync(key, legacy, sharedOptions);
  return legacy;
}

export function setSecret(key: string, value: string): Promise<void> {
  return SecureStore.setItemAsync(key, value, sharedOptions);
}

/** No accessGroup on purpose: the query then matches the shared group and any pre-migration copy alike. */
export function deleteSecret(key: string): Promise<void> {
  return SecureStore.deleteItemAsync(key);
}
