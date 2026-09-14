import { bytesToHex, randomBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Generates a fresh, versioned content key: 32 random bytes. Shared by
 * every member holding this version (sealed to each individually — see
 * `sealToPublicKey`); a removed member's exclusion from the *next*
 * version's wraps is what revokes their access.
 */
export function generateContentKey(): Uint8Array {
  return randomBytes(32);
}

const WRITE_TOKEN_DOMAIN = new TextEncoder().encode('relay-write-token');

/**
 * Derives the write token for one content-key version —
 * `HKDF(contentKey, "relay-write-token")`. Everyone holding this key
 * version computes the identical token; the relay only ever sees its hash
 * (see `hashWriteToken`), never this value or the key it came from. This
 * is what proves "a current member" to the relay without the relay
 * learning who.
 */
export function deriveWriteToken(contentKey: Uint8Array): Uint8Array {
  return hkdf(sha256, contentKey, undefined, WRITE_TOKEN_DOMAIN, 32);
}

/**
 * `sha256(writeToken)`, hex-encoded — what actually gets sent to the
 * relay (as `initialWriteTokenHash`/`newWriteTokenHash`) or compared
 * against (the relay hashes a presented raw token the same way). Must
 * match the server's own `hashWriteToken` byte-for-byte — see
 * internal/storage/logstore/dynamodb/log_store.go.
 */
export function hashWriteToken(writeToken: Uint8Array): string {
  return bytesToHex(sha256(writeToken));
}
