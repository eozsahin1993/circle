import * as AppleAuthentication from 'expo-apple-authentication';

import { saveAuthToken } from '@/services/keystore';
import { signInWithApple as relaySignInWithApple, signInWithGoogle as relaySignInWithGoogle } from '@/services/relay';

export type SignInOutcome = 'success' | 'cancelled';

/**
 * Exchanges a Google ID token for a relay session and persists it. Takes
 * the token rather than running the whole flow itself, unlike
 * signInWithApple below — expo-auth-session's Google prompt is a React
 * hook and can't be called from a plain function, so getting the token is
 * necessarily the caller's job (see hooks/use-google-sign-in.ts).
 */
export async function signInWithGoogle(idToken: string): Promise<void> {
  const token = await relaySignInWithGoogle(idToken);
  await saveAuthToken(token);
}

/**
 * Runs the entire native Apple sign-in flow — prompt, extract the
 * identity token, exchange it with the relay, persist the session — so
 * callers get a plain pass/cancelled outcome, never
 * AppleAuthenticationCredential's shape or expo-apple-authentication's
 * own cancel error code.
 */
export async function signInWithApple(): Promise<SignInOutcome> {
  let credential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_REQUEST_CANCELED') return 'cancelled';
    throw err;
  }

  if (!credential.identityToken) {
    throw new Error("Apple didn't return an identity token — try again.");
  }
  const token = await relaySignInWithApple(credential.identityToken);
  await saveAuthToken(token);
  return 'success';
}
