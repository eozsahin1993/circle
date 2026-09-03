import * as SecureStore from 'expo-secure-store';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import type { Keypair } from '@/services/crypto';

/**
 * A device's full local identity for one circle: the Ed25519 keypair, plus
 * the self-generated `memberId` it uses to reference itself in posts (see
 * `generateUUID()` in crypto.ts). Bundled together so signing and
 * posting need exactly one fast local read — no SQLite round-trip to find
 * "which roster row is me" every time you post.
 */
export type CircleIdentity = Keypair & { memberId: string };

function identityStorageKey(circleId: string) {
  return `circle_identity_${circleId}`;
}

function keyMapStorageKey(circleId: string) {
  return `circle_keys_${circleId}`;
}

/** One circle's full `{version -> content key}` map — see server/SYNC_DESIGN.md's "Content encryption" section. */
export type ContentKeyMap = Record<number, Uint8Array>;

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

/** Persists this circle's full content-key map, replacing whatever was stored before. */
export async function saveCircleKeyMap(circleId: string, keyMap: ContentKeyMap): Promise<void> {
  const value = JSON.stringify(Object.fromEntries(Object.entries(keyMap).map(([version, key]) => [version, bytesToHex(key)])));
  await SecureStore.setItemAsync(keyMapStorageKey(circleId), value);
}

/** Reads this circle's full content-key map back, or null if none is stored. */
export async function getCircleKeyMap(circleId: string): Promise<ContentKeyMap | null> {
  const raw = await SecureStore.getItemAsync(keyMapStorageKey(circleId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Record<string, string>;
  return Object.fromEntries(Object.entries(parsed).map(([version, hex]) => [Number(version), hexToBytes(hex)]));
}

/**
 * The content key this device should encrypt new content with and derive
 * the current write token from — the highest version in the map. Null if
 * no map is stored, or the map is empty.
 */
export async function getCurrentContentKey(circleId: string): Promise<{ version: number; key: Uint8Array } | null> {
  const keyMap = await getCircleKeyMap(circleId);
  if (!keyMap) return null;
  const versions = Object.keys(keyMap).map(Number);
  if (versions.length === 0) return null;
  const version = Math.max(...versions);
  return { version, key: keyMap[version] };
}

/**
 * Merges one new content-key version into whatever's already stored —
 * used when a rotation lands (see server/SYNC_DESIGN.md's "Remove a
 * member" operation), never overwrites older versions: a member needs
 * every version it's ever held to decrypt old content, not just the
 * current one.
 */
export async function addCircleKeyVersion(circleId: string, version: number, key: Uint8Array): Promise<void> {
  const existing = (await getCircleKeyMap(circleId)) ?? {};
  await saveCircleKeyMap(circleId, { ...existing, [version]: key });
}

/** Removes both the identity keypair and the content-key map for a circle (e.g. on leave). */
export async function deleteCircleKeys(circleId: string): Promise<void> {
  await SecureStore.deleteItemAsync(identityStorageKey(circleId));
  await SecureStore.deleteItemAsync(keyMapStorageKey(circleId));
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

/** Removes the master seed — used only by the __DEV__-only local reset tool, see domain/usecases/dev-reset.ts. */
export async function deleteMasterSeed(): Promise<void> {
  await SecureStore.deleteItemAsync(MASTER_SEED_KEY);
}

// TODO(erase-device): a deleteMasterSeed() belongs here once the separate
// "Erase this device" action (see sign-in.ts's signOut doc comment) is
// actually built — left out for now rather than sitting unused.

function pendingJoinKeypairStorageKey(requestId: string) {
  return `pending_join_keypair_${requestId}`;
}

/**
 * Persists the one-time ephemeral keypair for an outstanding join request
 * (see server/INVITE_FLOW.md) — the secret half of the sealed-box
 * handshake, so it belongs in the Keychain like every other secret key
 * here, not in the local `pendingJoinRequests` row (which only holds the
 * public half).
 */
export async function savePendingJoinKeypair(requestId: string, keypair: Keypair): Promise<void> {
  const value = JSON.stringify({
    publicKey: bytesToHex(keypair.publicKey),
    secretKey: bytesToHex(keypair.secretKey),
  });
  await SecureStore.setItemAsync(pendingJoinKeypairStorageKey(requestId), value);
}

/** Reads a pending join request's ephemeral keypair back, or null if none is stored. */
export async function getPendingJoinKeypair(requestId: string): Promise<Keypair | null> {
  const raw = await SecureStore.getItemAsync(pendingJoinKeypairStorageKey(requestId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { publicKey: string; secretKey: string };
  return { publicKey: hexToBytes(parsed.publicKey), secretKey: hexToBytes(parsed.secretKey) };
}

/** Removes a pending join request's ephemeral keypair — once the request completes or is abandoned. */
export async function deletePendingJoinKeypair(requestId: string): Promise<void> {
  await SecureStore.deleteItemAsync(pendingJoinKeypairStorageKey(requestId));
}

const AUTH_TOKEN_KEY = 'auth_token';

/**
 * Persists the relay's bearer session token (see server's authsession
 * package) — a credential, so Keychain, same as everything else here.
 * Not the same thing as local profile setup: this is about the relay
 * knowing which registered device is talking to it, not about whether
 * this device has a name/picture set up locally.
 */
export async function saveAuthToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
}

/** Reads the bearer session token back, or null before any provider sign-in has completed. */
export async function getAuthToken(): Promise<string | null> {
  return SecureStore.getItemAsync(AUTH_TOKEN_KEY);
}

/** Removes the stored session token — logout, or before signing in again with a different account. */
export async function deleteAuthToken(): Promise<void> {
  await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
}
