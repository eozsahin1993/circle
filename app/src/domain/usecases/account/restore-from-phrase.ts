import { listCircles } from '@/data/db';
import { fetchAccountManifest } from '@/domain/usecases/account/account-manifest';
import { seedPhraseToEntropy } from '@/services/crypto';
import { saveMasterSeed } from '@/services/keystore';

export type RestoreResult = {
  /**
   * How many circles the account's manifest says this seed belongs to.
   * Informational only: knowing the ids doesn't grant access to any of
   * them — see the note on keys in `restoreFromPhrase`. Null when the
   * relay couldn't be reached, which is not a reason to fail the restore.
   */
  circleCount: number | null;
};

/**
 * Puts a written-down recovery phrase back to work: validates it, adopts
 * the seed behind it, and reports what that seed is known to belong to.
 *
 * **This restores your identity, not your access.** Circle identities are
 * `HKDF(seed, circleId)`, so the seed alone regenerates the exact keypair
 * this account had before — the same public key already sitting in every
 * roster. Content keys are not derived; they're random, rotated, and
 * distributed by sealing them to each member individually. They cannot be
 * recomputed from anything, and they cannot be read out of the log either:
 * log entries are themselves encrypted under a content key, so a device
 * with no key can't read the entries that carry the keys.
 *
 * That is a property of the design rather than a gap in it — only another
 * member can let you back in. What the phrase buys is that when they do,
 * you return as *yourself*: same identity, same roster row, no duplicate
 * member, and your old posts still yours. Rejoining without the phrase
 * gets you a new keypair and a stranger's history.
 */
export async function restoreFromPhrase(phrase: string): Promise<RestoreResult> {
  const existing = await listCircles();
  if (existing.length > 0) {
    // Adopting a different seed would orphan them: their keys are filed
    // under identities this new seed can't reproduce.
    throw new Error('This phone is already in a circle. Restoring would lose it.');
  }

  // Throws on a bad word or a failed checksum, which catches most
  // transcription slips before anything is written.
  const seed = seedPhraseToEntropy(normalize(phrase));
  await saveMasterSeed(seed);

  try {
    return { circleCount: (await fetchAccountManifest()).circleIds?.length ?? 0 };
  } catch (err) {
    // Offline, or a manifest written under a different seed. Neither
    // undoes a valid phrase, so the restore stands either way.
    console.error('Restored the seed but could not read the account manifest', err);
    return { circleCount: null };
  }
}

/** BIP39 wants single-spaced lowercase; keyboards supply neither reliably. */
function normalize(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}
