import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { deleteSecret, getSecret, setSecret } from '@/core/services/keystore/store';
import type { Keypair } from '@/core/crypto/primitives';

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
