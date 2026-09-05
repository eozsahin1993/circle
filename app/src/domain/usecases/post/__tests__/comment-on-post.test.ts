jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  AttachmentKinds,
  AttachmentStatuses,
  getPendingOutboxEntries,
  getPostComments,
  initDatabase,
  insertPost,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { verifyLogEntry } from '@/domain/usecases/circle/log-entry';
import { addComment } from '@/domain/usecases/post/comment-on-post';
import { generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.resetAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

async function circleWithPost() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const postId = generateUUID();
  await insertPost(
    { id: postId, circleId, caption: 'c', authorPublicKey: bytesToHex(identity.publicKey), createdAt: 1, lastViewedAt: null },
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
      createdAt: 1,
    }
  );
  return { circleId, postId, identity };
}

test('stores the comment locally and queues one entry for sync', async () => {
  const { circleId, postId, identity } = await circleWithPost();

  await addComment(circleId, postId, 'Nana looks great');

  const [comment] = await getPostComments(circleId, postId);
  expect(comment).toMatchObject({ body: 'Nana looks great', authorPublicKey: bytesToHex(identity.publicKey) });

  const queued = (await getPendingOutboxEntries(circleId)).filter((entry) => entry.entryType === 'comment');
  expect(queued).toHaveLength(1);
});

test('the queued entry is signed and carries the same id as the local row', async () => {
  const { circleId, postId } = await circleWithPost();
  const contentKey = (await getCurrentContentKey(circleId))!.key;

  await addComment(circleId, postId, 'Same id both sides');

  const [comment] = await getPostComments(circleId, postId);
  const [queued] = (await getPendingOutboxEntries(circleId)).filter((entry) => entry.entryType === 'comment');
  // Every device ends up storing this id, which is what lets a future
  // reply or tombstone name this exact comment.
  expect(verifyLogEntry(queued.encryptedMeta, contentKey)).toMatchObject({
    type: 'comment',
    payload: { commentId: comment.id, postId, body: 'Same id both sides' },
  });
});

test('an empty or whitespace-only body writes nothing at all', async () => {
  const { circleId, postId } = await circleWithPost();

  await addComment(circleId, postId, '   ');

  expect(await getPostComments(circleId, postId)).toHaveLength(0);
  expect(await getPendingOutboxEntries(circleId)).toHaveLength(0);
});

test('the body is trimmed before it is stored or signed', async () => {
  const { circleId, postId } = await circleWithPost();
  const contentKey = (await getCurrentContentKey(circleId))!.key;

  await addComment(circleId, postId, '  padded  ');

  const [comment] = await getPostComments(circleId, postId);
  expect(comment.body).toBe('padded');
  const [queued] = (await getPendingOutboxEntries(circleId)).filter((entry) => entry.entryType === 'comment');
  // The signed payload must match what was stored, or the two diverge.
  expect(verifyLogEntry(queued.encryptedMeta, contentKey)).toMatchObject({ payload: { body: 'padded' } });
});

test('throws without an identity for the circle, writing nothing', async () => {
  await expect(addComment('not-a-real-circle', 'some-post', 'hi')).rejects.toThrow();
});
