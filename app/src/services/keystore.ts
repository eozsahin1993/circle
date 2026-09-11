import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/curves/utils.js';

import { APP_GROUP } from '@/services/app-group';
import type { Keypair } from '@/services/crypto';

/**
 * iOS secrets live in the shared App Group keychain so the notification
 * extension can read them — AFTER_FIRST_UNLOCK, because it runs while the
 * phone is locked and the default WHEN_UNLOCKED is unreadable exactly then.
 */
const sharedOptions: SecureStore.SecureStoreOptions | undefined =
  Platform.OS === 'ios' ? { accessGroup: APP_GROUP, keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK } : undefined;

async function getSecret(key: string): Promise<string | null> {
  if (!sharedOptions) return SecureStore.getItemAsync(key);

  const shared = await SecureStore.getItemAsync(key, sharedOptions);
  if (shared !== null) return shared;

  // Pre-App-Group installs hold their secrets in the app's own keychain
  // group; copy forward on first read. The old item is deliberately left
  // behind: a delete query without an accessGroup matches every group —
  // including the copy just written.
  const legacy = await SecureStore.getItemAsync(key);
  if (legacy !== null) await SecureStore.setItemAsync(key, legacy, sharedOptions);
  return legacy;
}

function setSecret(key: string, value: string): Promise<void> {
  return SecureStore.setItemAsync(key, value, sharedOptions);
}

/** No accessGroup on purpose: the query then matches the shared group and any pre-migration copy alike. */
function deleteSecret(key: string): Promise<void> {
  return SecureStore.deleteItemAsync(key);
}

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

/** One circle's full `{version -> content key}` map — every version this member has ever held, since old content stays encrypted under whichever key was current when it was posted. */
export type ContentKeyMap = Record<number, Uint8Array>;

/** Persists this circle's identity (keypair + own member ID) in the device Keychain/Keystore. */
export async function saveCircleIdentity(circleId: string, identity: CircleIdentity): Promise<void> {
  const value = JSON.stringify({
    publicKey: bytesToHex(identity.publicKey),
    secretKey: bytesToHex(identity.secretKey),
    memberId: identity.memberId,
  });
  await setSecret(identityStorageKey(circleId), value);
}

/** Reads this circle's identity back, or null if none is stored. */
export async function getCircleIdentity(circleId: string): Promise<CircleIdentity | null> {
  const raw = await getSecret(identityStorageKey(circleId));
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
  await setSecret(keyMapStorageKey(circleId), value);
}

/** Reads this circle's full content-key map back, or null if none is stored. */
export async function getCircleKeyMap(circleId: string): Promise<ContentKeyMap | null> {
  const raw = await getSecret(keyMapStorageKey(circleId));
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
 * used when a rotation lands, never overwrites older versions: a member
 * needs every version it's ever held to decrypt old content, not just the
 * current one.
 */
export async function addCircleKeyVersion(circleId: string, version: number, key: Uint8Array): Promise<void> {
  const existing = (await getCircleKeyMap(circleId)) ?? {};
  await saveCircleKeyMap(circleId, { ...existing, [version]: key });
}

/** Removes both the identity keypair and the content-key map for a circle (e.g. on leave). */
export async function deleteCircleKeys(circleId: string): Promise<void> {
  await deleteSecret(identityStorageKey(circleId));
  await deleteSecret(keyMapStorageKey(circleId));
}

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

function pendingJoinKeypairStorageKey(requestId: string) {
  return `pending_join_keypair_${requestId}`;
}

/**
 * Persists the one-time ephemeral keypair for an outstanding join request —
 * the secret half of the sealed-box handshake, so it belongs in the
 * Keychain like every other secret key here, not in the local
 * `pendingJoinRequests` row (which only holds the public half).
 */
export async function savePendingJoinKeypair(requestId: string, keypair: Keypair): Promise<void> {
  const value = JSON.stringify({
    publicKey: bytesToHex(keypair.publicKey),
    secretKey: bytesToHex(keypair.secretKey),
  });
  await setSecret(pendingJoinKeypairStorageKey(requestId), value);
}

/** Reads a pending join request's ephemeral keypair back, or null if none is stored. */
export async function getPendingJoinKeypair(requestId: string): Promise<Keypair | null> {
  const raw = await getSecret(pendingJoinKeypairStorageKey(requestId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { publicKey: string; secretKey: string };
  return { publicKey: hexToBytes(parsed.publicKey), secretKey: hexToBytes(parsed.secretKey) };
}

/** Removes a pending join request's ephemeral keypair — once the request completes or is abandoned. */
export async function deletePendingJoinKeypair(requestId: string): Promise<void> {
  await deleteSecret(pendingJoinKeypairStorageKey(requestId));
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
  await setSecret(AUTH_TOKEN_KEY, token);
}

/** Reads the bearer session token back, or null before any provider sign-in has completed. */
export async function getAuthToken(): Promise<string | null> {
  return getSecret(AUTH_TOKEN_KEY);
}

/** Removes the stored session token — logout, or before signing in again with a different account. */
export async function deleteAuthToken(): Promise<void> {
  await deleteSecret(AUTH_TOKEN_KEY);
}

const PUSH_DEVICE_SECRET_KEY = 'push_device_secret';

/**
 * This device's push secret, generated on first use. Every device id
 * derives from it, so it must not come from the master seed: devices share
 * that after a transfer and would all produce the same id, which is
 * exactly what lets the relay group them.
 */
export async function getPushDeviceSecret(): Promise<Uint8Array> {
  const stored = await getSecret(PUSH_DEVICE_SECRET_KEY);
  if (stored) return hexToBytes(stored);

  const secret = randomBytes(32);
  await setSecret(PUSH_DEVICE_SECRET_KEY, bytesToHex(secret));
  return secret;
}
