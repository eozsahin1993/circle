import { bytesToHex } from '@noble/curves/utils.js';

import { type Keypair, encrypt, sign } from '@/services/crypto';

/**
 * Every log entry's plaintext envelope, before encryption — see
 * server/SYNC_DESIGN.md's "Entry shape". `signature` covers `{type,
 * payload}` together, not `payload` alone, so a signature can't be
 * reinterpreted as a different type with the same payload shape. Opaque
 * to the relay; every client decrypts and verifies independently.
 */
export type LogEntryEnvelope = {
  type: string;
  payload: unknown;
  authorPubkey: string;
  signature: string;
};

/**
 * Builds and signs one entry's plaintext envelope — the shared primitive
 * every append goes through, so signing is never hand-rolled per call
 * site. Caller encrypts the result and tracks which key version was used
 * (sent as a separate plaintext field — see appendEntry in relay.ts).
 */
export function buildLogEntry(type: string, payload: unknown, identity: Keypair): Uint8Array {
  const message = new TextEncoder().encode(JSON.stringify({ type, payload }));
  const signature = sign(message, identity.secretKey);
  const envelope: LogEntryEnvelope = { type, payload, authorPubkey: bytesToHex(identity.publicKey), signature: bytesToHex(signature) };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/** `buildLogEntry`, then encrypted under `contentKey` — what every append call actually sends as `encryptedMeta`. */
export function buildAndEncryptLogEntry(type: string, payload: unknown, identity: Keypair, contentKey: Uint8Array): Uint8Array {
  return encrypt(buildLogEntry(type, payload, identity), contentKey);
}
