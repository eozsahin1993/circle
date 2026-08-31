import * as SecureStore from 'expo-secure-store';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import type { Keypair } from '@/lib/crypto';

/**
 * A device's full local identity for one circle: the Ed25519 keypair, plus
 * the self-generated `memberId` it uses to reference itself in posts (see
 * `generateMemberId()` in crypto.ts). Bundled together so signing and
 * posting need exactly one fast local read — no SQLite round-trip to find
 * "which roster row is me" every time you post.
 */
export type CircleIdentity = Keypair & { memberId: string };

function identityStorageKey(circleId: string) {
  return `circle_identity_${circleId}`;
}

function secretStorageKey(circleId: string) {
  return `circle_secret_${circleId}`;
}

/** Persists this circle's identity (keypair + own member ID) in the device Keychain/Keystore. */
export async function saveCircleIdentity(circleId: string, identity: CircleIdentity): Promise<void> {
  const value = JSON.stringify({
    publicKey: bytesToHex(identity.publicKey),
    secretKey: bytesToHex(identity.secretKey),
    memberId: identity.memberId,
  });
  await SecureStore.setItemAsync(identityStorageKey(circleId), value);
}

/** Reads this circle's identity back, or null if none is stored. */
export async function getCircleIdentity(circleId: string): Promise<CircleIdentity | null> {
  const raw = await SecureStore.getItemAsync(identityStorageKey(circleId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { publicKey: string; secretKey: string; memberId: string };
  return {
    publicKey: hexToBytes(parsed.publicKey),
    secretKey: hexToBytes(parsed.secretKey),
    memberId: parsed.memberId,
  };
}

/** Persists this circle's shared symmetric secret. */
export async function saveCircleSecret(circleId: string, secret: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(secretStorageKey(circleId), bytesToHex(secret));
}

/** Reads this circle's shared symmetric secret back, or null if none is stored. */
export async function getCircleSecret(circleId: string): Promise<Uint8Array | null> {
  const raw = await SecureStore.getItemAsync(secretStorageKey(circleId));
  return raw ? hexToBytes(raw) : null;
}

/** Removes both the identity keypair and the secret for a circle (e.g. on leave). */
export async function deleteCircleKeys(circleId: string): Promise<void> {
  await SecureStore.deleteItemAsync(identityStorageKey(circleId));
  await SecureStore.deleteItemAsync(secretStorageKey(circleId));
}

const MASTER_SEED_KEY = 'master_seed';

/**
 * Persists the device's one master seed (the 16 bytes behind the 12-word
 * recovery phrase). Singleton, not per-circle — every circle's keypair is
 * later derived from this plus an index, so it deserves at least as much
 * protection as any individual circle's key, arguably more.
 */
export async function saveMasterSeed(seed: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(MASTER_SEED_KEY, bytesToHex(seed));
}

/** Reads the master seed back, or null before onboarding has generated one. */
export async function getMasterSeed(): Promise<Uint8Array | null> {
  const raw = await SecureStore.getItemAsync(MASTER_SEED_KEY);
  return raw ? hexToBytes(raw) : null;
}
