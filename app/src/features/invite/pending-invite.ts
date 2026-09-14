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
 * Lands on the circle list, then opens a saved invite over it if there is
 * one. Two navigations rather than one because the invite is a sheet:
 * sending someone straight to it leaves whatever they signed in from
 * behind it — the welcome screen, complete with sign-in buttons — instead
 * of the circles they just arrived at.
 */
export async function goPostAuth(router: { replace: (href: '/circle') => void }): Promise<void> {
  // Always the circle list. A saved invite code stays saved — the list
  // reads it on mount and opens the join sheet over itself, so there is no
  // second destination to navigate to.
  router.replace('/circle');
}
