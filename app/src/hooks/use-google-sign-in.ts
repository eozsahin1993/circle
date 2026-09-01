import * as Google from 'expo-auth-session/providers/google';
import { Platform } from 'react-native';

import { signInWithGoogle } from '@/domain/usecases/sign-in';
import type { SignInOutcome } from '@/domain/usecases/sign-in';

/**
 * Wraps expo-auth-session's Google hook so callers just get a plain
 * pass/cancelled outcome (or a thrown Error with a message worth
 * showing) — never AuthSessionResult's cancel/dismiss/error/success
 * variants, or where the id token actually lives in the response shape.
 */
export function useGoogleSignIn(): { configured: boolean; signIn: () => Promise<SignInOutcome> } {
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
  const androidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '';
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
  const configured = Platform.select({ ios: !!iosClientId, android: !!androidClientId, default: !!webClientId });

  // expo-auth-session throws synchronously, on every render, if the
  // current platform's client id is `undefined` — always pass a string,
  // even an empty one; `configured` is what gates whether signIn() below
  // actually prompts.
  const [, , promptAsync] = Google.useIdTokenAuthRequest({ iosClientId, androidClientId, webClientId });

  async function signIn(): Promise<SignInOutcome> {
    if (!configured) {
      throw new Error("Google sign-in isn't configured on this build yet.");
    }
    const result = await promptAsync();
    if (result.type === 'cancel' || result.type === 'dismiss') return 'cancelled';
    if (result.type !== 'success') {
      throw new Error("Couldn't sign in with Google — try again.");
    }
    const idToken = result.authentication?.idToken ?? result.params.id_token;
    if (!idToken) {
      throw new Error("Google didn't return an ID token — try again.");
    }
    await signInWithGoogle(idToken);
    return 'success';
  }

  return { configured, signIn };
}
