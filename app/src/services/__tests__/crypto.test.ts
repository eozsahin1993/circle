import {
  decrypt,
  deriveCircleIdentity,
  deriveInvitePreviewKey,
  deriveInviteTag,
  deriveJoinRequestKey,
  deriveManifestKey,
  encrypt,
  generateEphemeralKeypair,
  openSealedBox,
  sealToPublicKey,
  sign,
  verify,
} from '@/services/crypto';

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

describe('invite code derivations', () => {
  test('deriveInviteTag is deterministic and code-specific', () => {
    expect(deriveInviteTag('AAAA-BBBB-CCCC')).toEqual(deriveInviteTag('AAAA-BBBB-CCCC'));
    expect(deriveInviteTag('AAAA-BBBB-CCCC')).not.toEqual(deriveInviteTag('DDDD-EEEE-FFFF'));
  });

  test('deriveInvitePreviewKey and deriveJoinRequestKey are deterministic, code-specific, and unrelated to each other', () => {
    expect(deriveInvitePreviewKey('AAAA-BBBB-CCCC')).toEqual(deriveInvitePreviewKey('AAAA-BBBB-CCCC'));
    expect(deriveInvitePreviewKey('AAAA-BBBB-CCCC')).not.toEqual(deriveInvitePreviewKey('DDDD-EEEE-FFFF'));
    expect(deriveInvitePreviewKey('AAAA-BBBB-CCCC')).not.toEqual(deriveJoinRequestKey('AAAA-BBBB-CCCC'));
  });

  test('deriveInviteTag is unrelated to either derived key (not just a truncation of one)', () => {
    const tag = deriveInviteTag('AAAA-BBBB-CCCC');
    const previewKey = Buffer.from(deriveInvitePreviewKey('AAAA-BBBB-CCCC')).toString('hex');
    expect(tag).not.toEqual(previewKey);
  });

  test('deriveInvitePreviewKey produces a key usable for encrypt/decrypt round trips', () => {
    const key = deriveInvitePreviewKey('AAAA-BBBB-CCCC');
    const plaintext = new TextEncoder().encode('Family Circle');

    expect(decrypt(encrypt(plaintext, key), key)).toEqual(plaintext);
  });
});

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
