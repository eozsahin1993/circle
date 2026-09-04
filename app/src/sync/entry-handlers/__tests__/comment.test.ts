jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  AttachmentKinds,
  AttachmentStatuses,
  getPostComments,
  initDatabase,
  insertPost,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { commentHandler } from '@/sync/entry-handlers/comment';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.resetAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

/** Handlers only ever see envelopes the walker already decrypted and verified. */
function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'comment', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

function payloadFor(postId: string, overrides: Record<string, unknown> = {}) {
  return { commentId: generateUUID(), postId, body: 'Lovely photo', createdAt: 7000, ...overrides };
}

/** A circle with one post already applied — the normal state when its comments arrive. */
async function circleWithPost() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const author = (await getCircleIdentity(circleId))!;
  const postId = generateUUID();
  await insertPost(
    { id: postId, circleId, caption: 'c', authorPublicKey: bytesToHex(author.publicKey), createdAt: 1000 },
    {
      circleId,
      entryId: postId,
      kind: AttachmentKinds.POST_PHOTO,
      bytes: null,
      hash: 'h',
      keyVersion: 1,
      status: AttachmentStatuses.PENDING,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt: 1000,
    }
  );
  return { circleId, postId, author };
}

describe('predicate', () => {
  test('accepts a comment from a member on a post this device holds', async () => {
    const { circleId, postId, author } = await circleWithPost();

    await expect(
      commentHandler.predicate(circleId, envelope(bytesToHex(author.publicKey), payloadFor(postId)))
    ).resolves.toBe(true);
  });

  test('rejects a comment from someone this device has never seen join', async () => {
    const { circleId, postId } = await circleWithPost();
    const stranger = generateIdentity();

    await expect(
      commentHandler.predicate(circleId, envelope(bytesToHex(stranger.publicKey), payloadFor(postId)))
    ).resolves.toBe(false);
  });

  test.each([
    ['a non-object payload', 'nope'],
    ['a missing commentId', { postId: 'p', body: 'x', createdAt: 1 }],
    ['a missing postId', { commentId: 'c', body: 'x', createdAt: 1 }],
    ['a non-string body', { commentId: 'c', postId: 'p', body: 42, createdAt: 1 }],
    ['a non-numeric createdAt', { commentId: 'c', postId: 'p', body: 'x', createdAt: 'now' }],
  ])('rejects %s even from a real member', async (_label, payload) => {
    const { circleId, author } = await circleWithPost();

    await expect(commentHandler.predicate(circleId, envelope(bytesToHex(author.publicKey), payload))).resolves.toBe(
      false
    );
  });
});

describe('apply', () => {
  test('stores the comment against the author from the envelope', async () => {
    const { circleId, postId } = await circleWithPost();
    const other = generateIdentity();
    const otherKey = bytesToHex(other.publicKey);
    const payload = payloadFor(postId, { body: 'From another device' });

    await commentHandler.apply(circleId, envelope(otherKey, payload));

    const [comment] = await getPostComments(circleId, postId);
    expect(comment).toMatchObject({ body: 'From another device', authorPublicKey: otherKey, createdAt: 7000 });
  });

  test('resolves the author name live from the roster rather than storing it', async () => {
    const { circleId, postId, author } = await circleWithPost();

    await commentHandler.apply(circleId, envelope(bytesToHex(author.publicKey), payloadFor(postId)));

    const [comment] = await getPostComments(circleId, postId);
    // The founder's roster row carries the name; nothing was denormalized
    // onto the comment itself, so a later rename would follow.
    expect(comment.authorName).not.toBeNull();
    expect(Object.keys(comment)).not.toContain('authorName_stored');
  });

  test('a comment whose author has no roster row yet reads back with a null name, not a crash', async () => {
    const { circleId, postId } = await circleWithPost();
    const unknown = generateIdentity();

    await commentHandler.apply(circleId, envelope(bytesToHex(unknown.publicKey), payloadFor(postId)));

    const [comment] = await getPostComments(circleId, postId);
    expect(comment.authorName).toBeNull();
  });

  test('applying the same entry twice leaves one comment', async () => {
    const { circleId, postId, author } = await circleWithPost();
    const entry = envelope(bytesToHex(author.publicKey), payloadFor(postId));

    await commentHandler.apply(circleId, entry);
    await commentHandler.apply(circleId, entry);

    expect(await getPostComments(circleId, postId)).toHaveLength(1);
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { circleId, postId } = await circleWithPost();

    await expect(commentHandler.apply(circleId, envelope('aa', { nonsense: true }))).resolves.toBeUndefined();

    expect(await getPostComments(circleId, postId)).toHaveLength(0);
  });
});
