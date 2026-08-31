import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, concatBytes, randomBytes } from '@noble/curves/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { generateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** 128 bits of entropy — the standard tier, same security level as AES-128. */
const SEED_STRENGTH_BITS = 128;

const NONCE_LENGTH = 24;
const ID_LENGTH = 16;

/**
 * Generates a locally-unique, self-assigned ID: 16 random bytes,
 * hex-encoded — the same 128 bits of randomness a UUID v4 provides,
 * without needing UUID's dash formatting or version bits, which nothing
 * here consumes.
 */
function generateId(): string {
  return bytesToHex(randomBytes(ID_LENGTH));
}

/** Generates a unique local circle ID. */
export function generateCircleId(): string {
  return generateId();
}

/**
 * Generates the compact ID a member uses to reference themselves in posts,
 * instead of embedding their full 32-byte public key every time. Chosen
 * once, by the member themselves, at join time — never derived from other
 * members' state, so no two devices can ever compute a conflicting value
 * for the same person (see the roster_index coordination-bug discussion).
 */
export function generateMemberId(): string {
  return generateId();
}

/**
 * Generates a fresh 12-word recovery phrase (128 bits of entropy). This is
 * the device's one master seed — persisted locally (never sent anywhere,
 * never shown in the UI today) so future circles can derive their keys
 * from it without asking the user to retype it every time. A manual
 * backup/reveal path (words, QR, or otherwise) is deliberately deferred —
 * see the account-recovery design notes in project memory.
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

export type Keypair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

/**
 * Generates a fresh Ed25519 identity keypair. Call this once per circle —
 * never reuse the same keypair across circles, or your public key becomes
 * a stable pseudonym that links your membership across otherwise-unrelated
 * groups (see the cross-circle correlation discussion).
 */
export function generateIdentity(): Keypair {
  return ed25519.keygen();
}

/**
 * Generates a fresh circle secret: 32 random bytes, unrelated to any
 * keypair. This is the symmetric secret shared with every member of one
 * circle — used to derive routing tags and encrypt/decrypt circle content.
 */
export function generateCircleSecret(): Uint8Array {
  return randomBytes(32);
}

/**
 * Encrypts `plaintext` under the circle's shared secret using
 * XChaCha20-Poly1305 (AEAD — tampering makes decrypt fail, it doesn't
 * silently return corrupted data). A fresh random nonce is generated per
 * call and prepended to the returned bytes, since decrypt needs it back.
 */
export function encrypt(plaintext: Uint8Array, secret: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = xchacha20poly1305(secret, nonce).encrypt(plaintext);
  return concatBytes(nonce, ciphertext);
}

/**
 * Decrypts what `encrypt` produced: splits the leading nonce back off,
 * then decrypts the rest. Throws if the ciphertext was tampered with or
 * `secret` doesn't match what it was encrypted under.
 */
export function decrypt(ciphertext: Uint8Array, secret: Uint8Array): Uint8Array {
  const nonce = ciphertext.subarray(0, NONCE_LENGTH);
  const box = ciphertext.subarray(NONCE_LENGTH);
  return xchacha20poly1305(secret, nonce).decrypt(box);
}

/**
 * Signs `message` with `secretKey`, producing a 64-byte Ed25519 signature
 * that anyone holding the matching public key can verify — without ever
 * needing the secret key themselves.
 */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

/**
 * Verifies that `signature` over `message` was produced by whoever holds
 * the secret key matching `publicKey`. Returns false on any mismatch or
 * tampering — never throws for an invalid signature.
 */
export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  return ed25519.verify(signature, message, publicKey);
}
