import { decrypt, deriveCircleIdentity, deriveManifestKey, encrypt, sign, verify } from '@/services/crypto';

describe('deriveCircleIdentity', () => {
  test('is deterministic for the same seed and circleId', () => {
    const seed = new Uint8Array(16).fill(7);

    const a = deriveCircleIdentity(seed, 'circle-1');
    const b = deriveCircleIdentity(seed, 'circle-1');

    expect(a.publicKey).toEqual(b.publicKey);
    expect(a.secretKey).toEqual(b.secretKey);
  });

  test('produces a different keypair per circleId', () => {
    const seed = new Uint8Array(16).fill(7);

    const a = deriveCircleIdentity(seed, 'circle-1');
    const b = deriveCircleIdentity(seed, 'circle-2');

    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  test('produces a different keypair per seed', () => {
    const a = deriveCircleIdentity(new Uint8Array(16).fill(1), 'circle-1');
    const b = deriveCircleIdentity(new Uint8Array(16).fill(2), 'circle-1');

    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  test('produces a usable signing keypair', () => {
    const identity = deriveCircleIdentity(new Uint8Array(16).fill(7), 'circle-1');
    const message = new TextEncoder().encode('hello');

    const signature = sign(message, identity.secretKey);

    expect(verify(signature, message, identity.publicKey)).toBe(true);
  });
});

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
