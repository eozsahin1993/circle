import { deleteSecret, getSecret, setSecret } from '@/core/services/keystore/store';

const AUTH_TOKEN_KEY = 'auth_token';

/**
 * Persists the relay's bearer session token (see server's authsession
 * package) — a credential, so Keychain, same as everything else here.
 * Not the same thing as local profile setup: this is about the relay
 * knowing which registered device is talking to it, not about whether
 * this device has a name/picture set up locally.
 */
export async function saveAuthToken(token: string): Promise<void> {
  await setSecret(AUTH_TOKEN_KEY, token);
}

/** Reads the bearer session token back, or null before any provider sign-in has completed. */
export async function getAuthToken(): Promise<string | null> {
  return getSecret(AUTH_TOKEN_KEY);
}

/** Removes the stored session token — logout, or before signing in again with a different account. */
export async function deleteAuthToken(): Promise<void> {
  await deleteSecret(AUTH_TOKEN_KEY);
}
