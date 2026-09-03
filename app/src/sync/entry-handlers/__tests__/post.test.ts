jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { getAttachment, getCircleFeed, getPendingOutboxEntries, initDatabase, markAttachmentFetched } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { postHandler } from '@/sync/entry-handlers/post';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

/** See member-added.test.ts: handlers only see already-verified envelopes, so the signature here is inert. */
function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'post', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

function payloadFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    postId: generateUUID(),
    caption: 'Nana in the kitchen',
    photoHash: 'abc123',
    createdAt: 5000,
    keyVersion: 1,
    ...overrides,
  };
}

describe('predicate', () => {
  test('accepts a post from someone on the roster', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    await expect(
      postHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), payloadFor()))
    ).resolves.toBe(true);
  });

  test('rejects a post from someone this device has never seen join', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const stranger = generateIdentity();

    await expect(
      postHandler.predicate(circleId, envelope(bytesToHex(stranger.publicKey), payloadFor()))
    ).resolves.toBe(false);
  });

  test.each([
    ['a non-object payload', 42],
    ['a missing postId', { caption: 'x', photoHash: 'a', createdAt: 1, keyVersion: 1 }],
    ['an empty postId', { postId: '', caption: 'x', photoHash: 'a', createdAt: 1, keyVersion: 1 }],
    ['a non-numeric createdAt', { postId: 'p', caption: 'x', photoHash: 'a', createdAt: 'soon', keyVersion: 1 }],
    ['a missing keyVersion', { postId: 'p', caption: 'x', photoHash: 'a', createdAt: 1 }],
  ])('rejects %s even from a real member', async (_label, payload) => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    await expect(postHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), payload))).resolves.toBe(
      false
    );
  });
});

describe('apply', () => {
  test('writes the post and an attachment awaiting download', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const payload = payloadFor({ photoHash: 'deadbeef' });

    await postHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), payload));

    const [post] = await getCircleFeed(circleId);
    expect(post).toMatchObject({ id: payload.postId, caption: 'Nana in the kitchen', createdAt: 5000 });
    expect(post.photo).toBeNull();

    const attachment = await getAttachment(circleId, payload.postId as string);
    expect(attachment).toMatchObject({
      kind: 'post_photo',
      status: 'pending',
      hash: 'deadbeef',
      // The attachment's own createdAt mirrors the post's, since the
      // download queue orders by it.
      createdAt: 5000,
    });
  });

  test('records the author from the envelope, not from this device', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const other = generateIdentity();
    const otherKey = bytesToHex(other.publicKey);

    await postHandler.apply(circleId, envelope(otherKey, payloadFor()));

    const [post] = await getCircleFeed(circleId);
    expect(post.authorPublicKey).toBe(otherKey);
  });

  test('carries the entry key version, so a rotated key cannot be assumed later', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    // This device's current version is 1; the entry was written under 3.
    const payload = payloadFor({ keyVersion: 3 });

    await postHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), payload));

    const attachment = await getAttachment(circleId, payload.postId as string);
    // The blob was encrypted under version 3 — decrypting it with whatever
    // happens to be current would fail after any rotation.
    expect(attachment?.keyVersion).toBe(3);
  });

  test('does not queue the pulled post back out to the relay', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    await postHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), payloadFor()));

    // insertPostAndEnqueue would have echoed it straight back to the relay
    // it just arrived from.
    expect(await getPendingOutboxEntries(circleId)).toHaveLength(0);
  });

  test('applying the same entry twice leaves one post', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const entry = envelope(bytesToHex(founder.publicKey), payloadFor());

    await postHandler.apply(circleId, entry);
    await postHandler.apply(circleId, entry);

    expect(await getCircleFeed(circleId)).toHaveLength(1);
  });

  test('a post that already has its photo is not reset to pending by a replay', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const payload = payloadFor();
    const entry = envelope(bytesToHex(founder.publicKey), payload);
    await postHandler.apply(circleId, entry);

    await markAttachmentFetched(circleId, payload.postId as string, new Uint8Array([1, 2, 3]));
    await postHandler.apply(circleId, entry);

    const attachment = await getAttachment(circleId, payload.postId as string);
    expect(attachment?.status).toBe('fetched');
    expect(attachment?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });

    await expect(postHandler.apply(circleId, envelope('aa', { nonsense: true }))).resolves.toBeUndefined();

    expect(await getCircleFeed(circleId)).toHaveLength(0);
  });
});
