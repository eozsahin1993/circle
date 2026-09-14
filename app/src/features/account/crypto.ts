import { bytesToHex, concatBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** 128 bits of entropy — the standard tier, same security level as AES-128. */
const SEED_STRENGTH_BITS = 128;

/**
 * Generates a fresh 12-word recovery phrase (128 bits of entropy). This is
 * the device's one master seed — persisted locally (never sent anywhere,
 * never shown in the UI today) so future circles can derive their keys
 * from it without asking the user to retype it every time. A manual
 * backup/reveal path (words, QR, or otherwise) is deliberately deferred —
 * not designed yet, nothing to point to for it.
 */
export function generateSeedPhrase(): string {
  return generateMnemonic(wordlist, SEED_STRENGTH_BITS);
}

/**
 * Recovers the raw 16-byte entropy behind a seed phrase — either the one
 * just generated (to persist it) or one a user typed back in during
 * recovery. Throws if the words or checksum aren't a valid BIP39 phrase,
 * which catches most transcription mistakes immediately rather than
 * silently deriving the wrong keys.
 */
export function seedPhraseToEntropy(phrase: string): Uint8Array {
  return mnemonicToEntropy(phrase, wordlist);
}

const MANIFEST_KEY_DOMAIN = new TextEncoder().encode('recovery-manifest');

/**
 * Derives the symmetric key that encrypts the account-recovery manifest —
 * each circle's address and content keys, plus this account's profile —
 * before it's sent to the relay. Only this seed can decrypt it, which is
 * what lets a phrase alone rebuild an account and why a stolen backup or
 * database dump hands over neither the circles nor the keys to read them.
 * The relay still learns the same membership in real time from ordinary
 * authenticated circle-log requests, which this encryption doesn't hide.
 */
export function deriveManifestKey(masterSeed: Uint8Array): Uint8Array {
  return hkdf(sha256, masterSeed, undefined, MANIFEST_KEY_DOMAIN, 32);
}

const DEVICE_TRANSFER_TAG_DOMAIN = new TextEncoder().encode('device-transfer-tag');
const DEVICE_TRANSFER_REQUEST_KEY_DOMAIN = new TextEncoder().encode('device-transfer-request');

/**
 * Derives the relay-visible tag for a device transfer's mailbox row —
 * same shape as `deriveInviteTag`, a different domain string so a
 * transfer code can never address an invite's row or vice versa.
 */
export function deriveDeviceTransferTag(transferCode: string): string {
  return bytesToHex(sha256(concatBytes(DEVICE_TRANSFER_TAG_DOMAIN, new TextEncoder().encode(transferCode))));
}

/**
 * `HKDF(transfer_code, "device-transfer-request")` — encrypts the waiting
 * device's row, so the relay doesn't learn a device model name it has no
 * other way to see. Only the phone that scanned the QR holds the code.
 */
export function deriveDeviceTransferRequestKey(transferCode: string): Uint8Array {
  return hkdf(sha256, new TextEncoder().encode(transferCode), undefined, DEVICE_TRANSFER_REQUEST_KEY_DOMAIN, 32);
}
