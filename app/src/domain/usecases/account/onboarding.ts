import { generateSeedPhrase, seedPhraseToEntropy } from '@/services/crypto';
import { saveProfile } from '@/data/db';
import { broadcastProfileUpdate } from '@/domain/usecases/circle/broadcast-profile-update';
import { getMasterSeed, saveMasterSeed } from '@/services/keystore';

export type ProfileInput = {
  name: string;
  picture: Uint8Array | null;
};

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
 *
 * Never overwrites an existing seed. Keychain survives a same-device
 * reinstall even though device_profile (SQLite) doesn't, so this can run
 * again with a real seed already sitting in Keychain — generating a new
 * one here would silently orphan every circle tied to the original.
 */
export async function completeProfileSetup(profile: ProfileInput): Promise<void> {
  const now = Date.now();
  await saveProfile({ ...profile, createdAt: now, updatedAt: now });
  await broadcastProfileUpdate(profile.name, profile.picture);

  const existingSeed = await getMasterSeed();
  if (!existingSeed) {
    await saveMasterSeed(seedPhraseToEntropy(generateSeedPhrase()));
  }
}
