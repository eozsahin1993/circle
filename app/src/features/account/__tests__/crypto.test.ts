import { decrypt, encrypt } from '@/core/crypto/primitives';
import { deriveManifestKey } from '@/features/account/crypto';

describe('deriveManifestKey', () => {
  test('is deterministic for the same seed', () => {
    const seed = new Uint8Array(16).fill(3);

    expect(deriveManifestKey(seed)).toEqual(deriveManifestKey(seed));
  });

  test('produces a different key per seed', () => {
    const a = deriveManifestKey(new Uint8Array(16).fill(1));
    const b = deriveManifestKey(new Uint8Array(16).fill(2));

    expect(a).not.toEqual(b);
  });

  test('produces a key usable for encrypt/decrypt round trips', () => {
    const key = deriveManifestKey(new Uint8Array(16).fill(3));
    const plaintext = new TextEncoder().encode('circle-1,circle-2');

    expect(decrypt(encrypt(plaintext, key), key)).toEqual(plaintext);
  });
});
