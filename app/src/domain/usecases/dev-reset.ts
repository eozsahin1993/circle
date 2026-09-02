import { getAllCircleIds, resetAllLocalData } from '@/data/db';
import { deleteAuthToken, deleteCircleKeys, deleteMasterSeed } from '@/services/keystore';

/**
 * DEV-ONLY testing tool — wipes every circle identity/secret in the
 * Keychain, the master seed, the auth token, and all local circle/post/etc.
 * data, so a fresh sign-in can be exercised repeatedly without reinstalling
 * the app each time.
 *
 * Deliberately kept out of sign-in.ts's signOut(): this is the same scope
 * as the deferred, real "Erase this device" feature described in that
 * file's TODO, but with none of the safety net a real user-facing version
 * needs (no recovery-phrase confirmation, no "this can't be undone"
 * gating). Only ever call this from a `__DEV__`-gated UI action — never
 * wire it into anything a production build can reach.
 */
export async function resetLocalDataForTesting(): Promise<void> {
  const circleIds = await getAllCircleIds();
  for (const circleId of circleIds) {
    await deleteCircleKeys(circleId);
  }
  await deleteMasterSeed();
  await deleteAuthToken();
  await resetAllLocalData();
}
