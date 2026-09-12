import { generateSeedPhrase, seedPhraseToEntropy } from '@/services/crypto';
import { saveProfile } from '@/data/db';
import { broadcastProfileUpdate } from '@/domain/usecases/circle/broadcast-profile-update';
import { getMasterSeed, saveMasterSeed } from '@/services/keystore';

export type ProfileInput = {
  name: string;
  picture: Uint8Array | null;
};

/**
 * Returns the device's master seed, generating and persisting one first if
 * none exists yet. Never overwrites an existing seed. Keychain survives a
 * same-device reinstall even though device_profile (SQLite) doesn't, so
 * this can run again with a real seed already sitting in Keychain —
 * generating a new one here would silently orphan every circle tied to
 * the original.
 *
 * Safe to call before profile setup finishes (see profile-setup.tsx, which
 * calls this on mount so the avatar preview has a stable colour to derive
 * from before "Continue" is ever pressed) — the seed itself has nothing to
 * do with the name or picture typed in on that screen.
 *
 * De-dupes concurrent calls through the one in-flight promise: that mount
 * and a fast tap on "Continue" racing each other on a brand-new install
 * would otherwise both see no seed yet and each generate their own — a
 * silent, last-write-wins split rather than a shared one.
 */
let pendingMasterSeed: Promise<Uint8Array> | null = null;

export async function ensureMasterSeed(): Promise<Uint8Array> {
  if (pendingMasterSeed) return pendingMasterSeed;

  pendingMasterSeed = (async () => {
    const existing = await getMasterSeed();
    if (existing) return existing;
    const seed = seedPhraseToEntropy(generateSeedPhrase());
    await saveMasterSeed(seed);
    return seed;
  })();

  try {
    return await pendingMasterSeed;
  } finally {
    pendingMasterSeed = null;
  }
}

/**
 * Saves the device profile, tells every circle about it, and ensures a
 * master seed exists — what "finish setting up your profile" means. Silent
 * for now: no reveal/backup screen, Keychain-only, until a deliberate
 * manual-backup design (QR or otherwise) gets built later.
 *
 * The broadcast matters on every run but the first: this screen is also
 * how an existing profile is edited (see profile-setup.tsx), and
 * `member_added` carries a member's name and picture only as they were at
 * join time. Without the entry a later change reaches no other device, and
 * not even this one's own roster row. On first run there are no circles
 * yet and it does nothing.
 */
export async function completeProfileSetup(profile: ProfileInput): Promise<void> {
  const now = Date.now();
  await saveProfile({ ...profile, createdAt: now, updatedAt: now });
  await broadcastProfileUpdate(profile.name, profile.picture);
  await ensureMasterSeed();
}
