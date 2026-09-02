import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSignin, isErrorWithCode, isSuccessResponse, statusCodes } from '@react-native-google-signin/google-signin';
import { Platform } from 'react-native';

import { deleteAuthToken, getAuthToken, saveAuthToken } from '@/services/keystore';
import {
  logout as relayLogout,
  signInWithApple as relaySignInWithApple,
  signInWithGoogle as relaySignInWithGoogle,
} from '@/services/relay';

export type SignInOutcome = 'success' | 'cancelled';

/**
 * suggestedName/suggestedPictureUrl are purely a profile-setup UX
 * convenience — never sent anywhere, just handed to the caller so it can
 * pre-fill the form instead of asking someone to retype what their sign-in
 * provider already told the device. Apple never provides a photo (Sign in
 * with Apple has no picture concept at all); its name is only ever
 * present on a person's very first authorization for this app, so it has
 * to be captured right here or it's gone for good.
 */
export type SignInResult = {
  outcome: SignInOutcome;
  suggestedName?: string;
  suggestedPictureUrl?: string;
};

let googleConfigured = false;

/**
 * GoogleSignin.configure() only needs to run once per process — lazy and
 * memoized here rather than at module scope, so a build missing the env
 * vars doesn't throw on import, only when sign-in is actually attempted.
 */
function ensureGoogleConfigured(): void {
  if (googleConfigured) return;
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  if (!webClientId) {
    // Required on every platform, not just iOS — the native SDK only
    // populates idToken in the response if webClientId is set, regardless
    // of which platform client actually drove the sign-in UI.
    throw new Error("Google sign-in isn't configured on this build yet.");
  }
  GoogleSignin.configure({ iosClientId, webClientId });
  googleConfigured = true;
}

/**
 * Runs the entire native Google sign-in flow — same shape as
 * signInWithApple below, now that @react-native-google-signin/google-signin
 * (a plain async function, not a React hook the way expo-auth-session's
 * Google prompt was) makes that possible.
 */
export async function signInWithGoogle(): Promise<SignInResult> {
  ensureGoogleConfigured();

  try {
    // Play Services availability only matters on Android — iOS has no
    // equivalent concept, and the native module doesn't require the check.
    if (Platform.OS === 'android') {
      await GoogleSignin.hasPlayServices();
    }
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) return { outcome: 'cancelled' };

    const idToken = response.data.idToken;
    if (!idToken) {
      throw new Error("Google didn't return an ID token — try again.");
    }
    const token = await relaySignInWithGoogle(idToken);
    await saveAuthToken(token);
    return {
      outcome: 'success',
      // .name is the combined display name — givenName/familyName are
      // reportedly unreliable on iOS (often null there), so this is the
      // one field actually worth relying on cross-platform.
      suggestedName: response.data.user.name ?? undefined,
      suggestedPictureUrl: response.data.user.photo ?? undefined,
    };
  } catch (err) {
    if (isErrorWithCode(err) && err.code === statusCodes.SIGN_IN_CANCELLED) {
      return { outcome: 'cancelled' };
    }
    throw err;
  }
}

/**
 * Runs the entire native Apple sign-in flow — prompt, extract the
 * identity token, exchange it with the relay, persist the session — so
 * callers get a plain pass/cancelled outcome, never
 * AppleAuthenticationCredential's shape or expo-apple-authentication's
 * own cancel error code.
 */
export async function signInWithApple(): Promise<SignInResult> {
  let credential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_REQUEST_CANCELED') return { outcome: 'cancelled' };
    throw err;
  }

  if (!credential.identityToken) {
    throw new Error("Apple didn't return an identity token — try again.");
  }
  const token = await relaySignInWithApple(credential.identityToken);
  await saveAuthToken(token);

  const suggestedName = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ');
  return { outcome: 'success', suggestedName: suggestedName || undefined };
}

/**
 * Revokes the current session server-side and clears the locally stored
 * token. Deliberately *doesn't* touch circle keys, the master seed, or any
 * local circle/post data — relay auth and local circle content are
 * decoupled by design (the relay is blind to circles entirely), so
 * signing out is meant to be low-stakes and reversible: sign back in and
 * everything local is exactly as you left it. The server revoke is
 * best-effort — offline or relay-down doesn't block signing out locally.
 *
 * TODO(erase-device): a *separate*, clearly-destructive "Erase this
 * device" action still needs building — wipe every circle_identity_/
 * circle_secret_ Keychain entry, the master seed, and all local
 * circle/post/etc. data. Do NOT fold that into signOut() again; it was
 * tried and reverted because it silently destroyed the only copy of the
 * master seed with no safety net. That action needs to force the user
 * through the recovery-phrase reveal (account/recovery.tsx) and confirm
 * they've saved it *before* proceeding — and even then, recovery only
 * restores access on *this* device if the phrase was actually written
 * down somewhere durable; there's no server-side backup of it (see
 * DESIGN.md discussion on why a naive password-protected server backup
 * is a real security regression, and what Signal-style attested-hardware
 * rate-limiting would take to do this properly).
 */
export async function signOut(): Promise<void> {
  const token = await getAuthToken();
  if (token) {
    try {
      await relayLogout(token);
    } catch (err) {
      console.error('Failed to revoke session server-side', err);
    }
  }
  await deleteAuthToken();
}
