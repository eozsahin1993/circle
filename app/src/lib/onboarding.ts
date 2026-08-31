import { generateSeedPhrase, seedPhraseToEntropy } from '@/lib/crypto';
import { saveProfile } from '@/lib/db';
import { getMasterSeed, saveMasterSeed } from '@/lib/keystore';

export type ProfileInput = {
  name: string;
  picture: Uint8Array | null;
};

/**
 * Saves the device profile and ensures a master seed exists — the two
 * things "finish setting up your profile" actually means. Silent for now:
 * no reveal/backup screen, Keychain-only, until a deliberate manual-backup
 * design (QR or otherwise) gets built later.
 *
 * Never overwrites an existing seed. Keychain survives a same-device
 * reinstall even though device_profile (SQLite) doesn't, so this can run
 * again with a real seed already sitting in Keychain — generating a new
 * one here would silently orphan every circle tied to the original.
 */
export async function completeProfileSetup(profile: ProfileInput): Promise<void> {
  const now = Date.now();
  await saveProfile({ ...profile, createdAt: now, updatedAt: now });

  const existingSeed = await getMasterSeed();
  if (!existingSeed) {
    await saveMasterSeed(seedPhraseToEntropy(generateSeedPhrase()));
  }
}
