import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { deleteSecret, getSecret, setSecret } from '@/core/services/keystore/store';

const MASTER_SEED_KEY = 'master_seed';

/**
 * Persists the device's one master seed (the 16 bytes behind the 12-word
 * recovery phrase). Singleton, not per-circle — every circle's keypair is
 * later derived from this plus an index, so it deserves at least as much
 * protection as any individual circle's key, arguably more.
 */
export async function saveMasterSeed(seed: Uint8Array): Promise<void> {
  await setSecret(MASTER_SEED_KEY, bytesToHex(seed));
}

/** Reads the master seed back, or null before onboarding has generated one. */
export async function getMasterSeed(): Promise<Uint8Array | null> {
  const raw = await getSecret(MASTER_SEED_KEY);
  return raw ? hexToBytes(raw) : null;
}

/** Removes the master seed — used only by the __DEV__-only local reset tool, see domain/usecases/dev-reset.ts. */
export async function deleteMasterSeed(): Promise<void> {
  await deleteSecret(MASTER_SEED_KEY);
}

// TODO(erase-device): a deleteMasterSeed() belongs here once the separate
// "Erase this device" action (see sign-in.ts's signOut doc comment) is
// actually built — left out for now rather than sitting unused.
