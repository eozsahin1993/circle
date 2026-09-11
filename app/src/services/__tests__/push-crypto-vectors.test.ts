import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, concatBytes } from '@noble/curves/utils.js';

import { deriveCircleIdentity, derivePushRoutingId, verify } from '@/services/crypto';
import { buildLogEntry, verifyLogEntry } from '@/domain/usecases/circle/log-entry';

/**
 * Pins the exact bytes the Swift port in
 * targets/notification-service/CircleCrypto.swift must reproduce — the
 * reference for verifying that side, which has no test target of its own
 * (the generated Xcode project can't durably hold one).
 */

const seed = new Uint8Array(16).fill(1);
const contentKey = new Uint8Array(32).fill(2);
const nonce = new Uint8Array(24).fill(3);
const circleId = 'vector-circle';

test('routing id vector', () => {
  expect(derivePushRoutingId(seed, circleId)).toBe('42840a8d4ad2b7b7b8bb3d180ade5ca23f2f4589d39439ae4890895986aaaa71');
});

test('envelope vector decrypts and verifies', () => {
  const identity = deriveCircleIdentity(seed, circleId);
  const envelope = buildLogEntry(
    'comment',
    { commentId: 'c-1', postId: 'p-1', body: 'hello', createdAt: 1700000000000 },
    identity,
  );
  // encrypt() picks a random nonce; the vector needs a fixed one, so the
  // wire format (nonce || box) is assembled here the same way.
  const box = concatBytes(nonce, xchacha20poly1305(contentKey, nonce).encrypt(envelope));

  expect(bytesToHex(identity.publicKey)).toBe('2fe1c922370472c19cd96d90e785cc83d16c46a341870686f2e40c0841233983');
  expect(bytesToHex(box)).toBe('030303030303030303030303030303030303030303030303262b55264d3618bda250e8a359ea168dbb5df142eff79c7d2fcd823912fa473beb94f9443a1c11099f0a3737ee921a52352dafa2ade971d901ddb745a90ca4b05a325a6fc62ff33ae3eeb4b8bc68486262d124eb7f3d81b1b76aaf232fc533cdcdce8eaa3ec9f4a14117a6fc8277e34d2c366e610cbe7a2f84718f1e4f4974770bd547b55aaf2335d1d9ea0a992310807515a456f696446159fd0cef73f638d623d539d418bc03c31e200615fb0360d620a29a83c74f75c4f899f3527de49a14c02ce0f53ca511c3c7928d40a17adc807c68aee6c16454b9e820cd630276a2f9934b7e56e613e80e40b2055d685e1f180fcecd728ecb82b05bc3a49be36a205f3501a8fc2f7141a6941e32791adecf06a73e5ccfc8d8ad9210c53a8805ff97baaf5ec4c47a877099811f477c354996b77b1cad091d4d72a8a04057d41bffe488200d9b63877d142fe61bda616f348ede203aaa948975f7b7d5');

  const verified = verifyLogEntry(box, contentKey);
  expect(verified?.type).toBe('comment');
  expect((verified?.payload as { body: string }).body).toBe('hello');
});

test('a signed prefix cut at the last authorPubkey marker verifies', () => {
  // The Swift port extracts the signed message textually from the
  // plaintext instead of re-serializing JSON — this proves that recipe
  // against the same signature the JS side checks.
  const identity = deriveCircleIdentity(seed, circleId);
  const envelope = buildLogEntry('comment', { body: 'x,"authorPubkey":"decoy' }, identity);
  const text = new TextDecoder().decode(envelope);
  const marker = text.lastIndexOf(',"authorPubkey":"');
  const message = new TextEncoder().encode(text.slice(0, marker) + '}');
  const parsed = JSON.parse(text) as { signature: string; authorPubkey: string };
  expect(
    verify(
      Uint8Array.from(Buffer.from(parsed.signature, 'hex')),
      message,
      Uint8Array.from(Buffer.from(parsed.authorPubkey, 'hex')),
    ),
  ).toBe(true);
});
