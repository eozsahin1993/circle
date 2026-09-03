import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { type Keypair, decrypt, encrypt, sign, verify } from '@/services/crypto';

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

/**
 * The inverse of `buildAndEncryptLogEntry`, and the sync engine's single
 * default-deny chokepoint (server/SYNC_DESIGN.md invariant 5): decrypt,
 * parse, and check the signature actually covers `{type, payload}` —
 * re-serialized here exactly as `buildLogEntry` serialized it, since the
 * signature is over those bytes.
 *
 * Returns null for *every* way an entry can be untrustworthy — wrong
 * content key, tampered ciphertext, malformed JSON, missing fields, a
 * signature that doesn't verify — rather than throwing or distinguishing
 * between them. A caller can't do anything different about any of them:
 * the entry is discarded either way. Never throws, so one bad entry can't
 * abort a sync pass.
 */
export function verifyLogEntry(encryptedMeta: Uint8Array, contentKey: Uint8Array): LogEntryEnvelope | null {
  let envelope: LogEntryEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(decrypt(encryptedMeta, contentKey))) as LogEntryEnvelope;
  } catch {
    return null;
  }

  if (typeof envelope?.type !== 'string' || typeof envelope?.authorPubkey !== 'string' || typeof envelope?.signature !== 'string') {
    return null;
  }

  try {
    const message = new TextEncoder().encode(JSON.stringify({ type: envelope.type, payload: envelope.payload }));
    if (!verify(hexToBytes(envelope.signature), message, hexToBytes(envelope.authorPubkey))) return null;
  } catch {
    // Malformed hex in either field lands here rather than as a rejection.
    return null;
  }

  return envelope;
}
