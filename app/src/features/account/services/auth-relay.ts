import { baseUrl, describeError } from '@/core/services/relay';

/**
 * Exchanges a provider ID token for a relay bearer session token — POST
 * /v1/auth/google or /v1/auth/apple. See server/internal/api/authgoogle
 * and authapple: the relay verifies idToken against the provider's own
 * signing keys itself, this call doesn't trust anything client-side about
 * the token's contents.
 */
async function signIn(provider: 'google' | 'apple', idToken: string): Promise<string> {
  const response = await fetch(`${baseUrl()}/v1/auth/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, `${provider} sign-in failed`));
  }
  const body = await response.json();
  return body.token;
}

export const signInWithGoogle = (idToken: string) => signIn('google', idToken);
export const signInWithApple = (idToken: string) => signIn('apple', idToken);

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
