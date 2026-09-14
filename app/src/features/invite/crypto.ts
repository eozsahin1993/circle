import { bytesToHex, concatBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const INVITE_TAG_DOMAIN = new TextEncoder().encode('invite-tag');
const INVITE_PREVIEW_KEY_DOMAIN = new TextEncoder().encode('invite-preview');
const JOIN_REQUEST_KEY_DOMAIN = new TextEncoder().encode('join-request');

/**
 * Derives the relay-visible tag for an invite's mailbox row —
 * `sha256('invite-tag' || invite_code)`, hex-encoded. Both the invite's
 * creator and anyone holding the code compute this independently; same
 * domain-separated-hash pattern as `deriveCircleLogId`.
 */
export function deriveInviteTag(inviteCode: string): string {
  return bytesToHex(sha256(concatBytes(INVITE_TAG_DOMAIN, new TextEncoder().encode(inviteCode))));
}

/**
 * `HKDF(invite_code, "invite-preview")` — the symmetric key that
 * encrypts/decrypts an invite's preview row (circle name + cover
 * thumbnail). Computable by both the creator and anyone holding the code,
 * with no exchange needed — the invite code itself has enough entropy to
 * double as shared key material.
 */
export function deriveInvitePreviewKey(inviteCode: string): Uint8Array {
  return hkdf(sha256, new TextEncoder().encode(inviteCode), undefined, INVITE_PREVIEW_KEY_DOMAIN, 32);
}

/**
 * `HKDF(invite_code, "join-request")` — the symmetric key that
 * encrypts/decrypts a requester's `{ephemeralPublicKey, selfReportedName}`
 * payload. Same code-derived-key scheme as `deriveInvitePreviewKey`, a
 * different purpose string so the two keys are unrelated.
 */
export function deriveJoinRequestKey(inviteCode: string): Uint8Array {
  return hkdf(sha256, new TextEncoder().encode(inviteCode), undefined, JOIN_REQUEST_KEY_DOMAIN, 32);
}
