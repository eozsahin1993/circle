import { baseUrl, describeError } from '@/core/services/relay';

/**
 * Exchanges a provider ID token for a relay bearer session token — POST
 * /v1/auth/google or /v1/auth/apple. See server/internal/auth/http/google
 * and apple: the relay verifies idToken against the provider's own
 * signing keys itself, this call doesn't trust anything client-side about
 * the token's contents.
 */
async function signIn(provider: 'google' | 'apple', credentials: Record<string, string>): Promise<string> {
  const response = await fetch(`${baseUrl()}/v1/auth/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, `${provider} sign-in failed`));
  }
  const body = await response.json();
  return body.token;
}

export const signInWithGoogle = (idToken: string) => signIn('google', { idToken });

/**
 * authorizationCode is not part of authenticating anyone — the relay
 * exchanges it for a refresh token it can revoke when this account is
 * deleted, which App Store Review Guideline 5.1.1(v) requires. Apple
 * expires the code within minutes, so it can't be captured later, at
 * deletion, instead. See server/internal/auth/appleid.
 */
export const signInWithApple = (idToken: string, authorizationCode: string) =>
  signIn('apple', { idToken, authorizationCode });

/** Revokes a bearer session token — POST /v1/auth/logout. Idempotent, same as the endpoint itself. */
export async function logout(token: string): Promise<void> {
  const response = await fetch(`${baseUrl()}/v1/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'Logout failed'));
  }
}
