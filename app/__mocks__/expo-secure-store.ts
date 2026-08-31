// expo-secure-store has no native Keychain/Keystore bridge under Jest —
// setItemAsync/getItemAsync silently no-op there instead of erroring, so a
// read right after a write comes back null with no indication anything's
// wrong. This mock backs it with a plain in-memory Map, scoped to Jest's
// per-test-file module registry (so it doesn't leak between test files).
// Auto-applied by Jest for any test that imports 'expo-secure-store'.
const store = new Map<string, string>();

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function getItemAsync(key: string): Promise<string | null> {
  return store.get(key) ?? null;
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}

export async function isAvailableAsync(): Promise<boolean> {
  return true;
}

export function canUseBiometricAuthentication(): boolean {
  return false;
}
