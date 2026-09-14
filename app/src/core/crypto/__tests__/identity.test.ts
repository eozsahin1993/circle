import { sign, verify } from '@/core/crypto/primitives';
import { deriveCircleIdentity } from '@/core/crypto/identity';

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
