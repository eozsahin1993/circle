import { useEffect, useState } from 'react';

import { deriveOwnColorSeed } from '@/services/crypto';
import { getMasterSeed } from '@/services/keystore';

// Module-level, not per-hook-instance: `PostComments` mounts one of these
// per visible feed row, and every one of them wants the same value. Without
// this a long feed would fire one redundant Keychain read per row for a
// value that never differs between them.
let cached: string | undefined;
let inFlight: Promise<string | undefined> | null = null;

function load(): Promise<string | undefined> {
  if (!inFlight) {
    inFlight = getMasterSeed()
      .then((masterSeed) => {
        cached = masterSeed ? deriveOwnColorSeed(masterSeed) : undefined;
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Populates the cache directly from an already-resolved master seed —
 * for profile-setup.tsx, which has one in hand from `ensureMasterSeed` and
 * would otherwise make every screen mounted right after (circle list,
 * account) re-read the Keychain for a value this process already has.
 */
export function primeOwnColorSeed(masterSeed: Uint8Array): string {
  cached = deriveOwnColorSeed(masterSeed);
  return cached;
}

/**
 * Only the dev-only reset tool actually changes the master seed within a
 * running process (see dev-reset.ts) — ordinary sign-out deliberately never
 * touches it. Without clearing this, every mounted screen would keep
 * showing the previous account's colour until a real app restart.
 */
export function clearOwnColorSeedCache(): void {
  cached = undefined;
}

/**
 * This device's own avatar-color seed, stable across every circle and
 * every rename — see `deriveOwnColorSeed`. Undefined until a master seed
 * exists, which is only the very first moment of a fresh install, before
 * `ensureMasterSeed` (see profile-setup.tsx) has run even once.
 */
export function useOwnColorSeed(): string | undefined {
  const [seed, setSeed] = useState<string | undefined>(cached);

  useEffect(() => {
    if (cached !== undefined) return;
    load().then(setSeed);
  }, []);

  return seed;
}
