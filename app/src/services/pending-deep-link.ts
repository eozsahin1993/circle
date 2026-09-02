import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'pending_invite_code';

/**
 * Remembers an invite code tapped before the device could act on it (not
 * signed in yet, or profile setup incomplete) — not a secret, so
 * AsyncStorage, same as services/settings.ts. `takePendingInviteCode`
 * reads then clears in one step, so the same code is never replayed twice
 * (e.g. if sign-in completes more than once during onboarding).
 */
export async function savePendingInviteCode(code: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, code);
}

export async function takePendingInviteCode(): Promise<string | null> {
  const code = await AsyncStorage.getItem(STORAGE_KEY);
  if (code) await AsyncStorage.removeItem(STORAGE_KEY);
  return code;
}

/**
 * Where to send someone right after sign-in/profile-setup finishes — a
 * saved invite code (from tapping a link before either was ready) takes
 * priority over the default circle list, so the flow that brought them
 * here in the first place actually continues.
 */
export async function postAuthDestination() {
  const code = await takePendingInviteCode();
  return code ? ({ pathname: '/join/[code]', params: { code } } as const) : ('/circle' as const);
}
