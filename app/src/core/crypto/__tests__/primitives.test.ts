import { generateEphemeralKeypair, openSealedBox, sealToPublicKey } from '@/core/crypto/primitives';

describe('sealToPublicKey / openSealedBox', () => {
  test('round-trips a message to the recipient keypair', () => {
    const recipient = generateEphemeralKeypair();
    const plaintext = new TextEncoder().encode('the circle secret');

    const sealed = sealToPublicKey(plaintext, recipient.publicKey);

    expect(openSealedBox(sealed, recipient)).toEqual(plaintext);
  });

  test('fails to open with the wrong keypair', () => {
    const recipient = generateEphemeralKeypair();
    const wrongKeypair = generateEphemeralKeypair();
    const sealed = sealToPublicKey(new TextEncoder().encode('hello'), recipient.publicKey);

    expect(() => openSealedBox(sealed, wrongKeypair)).toThrow();
  });

  test('fails to open tampered ciphertext', () => {
    const recipient = generateEphemeralKeypair();
    const sealed = sealToPublicKey(new TextEncoder().encode('hello'), recipient.publicKey);
    sealed[sealed.length - 1] ^= 0xff;

    expect(() => openSealedBox(sealed, recipient)).toThrow();
  });

  test('generateEphemeralKeypair produces a different keypair each call', () => {
    const a = generateEphemeralKeypair();
    const b = generateEphemeralKeypair();

    expect(a.publicKey).not.toEqual(b.publicKey);
  });
});
