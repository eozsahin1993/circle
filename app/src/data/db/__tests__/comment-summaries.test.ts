jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  AttachmentKinds,
  AttachmentStatuses,
  getCommentSummaries,
  initDatabase,
  insertComment,
  insertPost,
  updateMemberProfile,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

async function circleWithPosts(count: number) {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const author = (await getCircleIdentity(circleId))!;
  const authorKey = bytesToHex(author.publicKey);
  const postIds: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const postId = generateUUID();
    postIds.push(postId);
    await insertPost(
      { id: postId, circleId, caption: 'c', authorPublicKey: authorKey, createdAt: 1000, lastViewedAt: null, inAlbum: true },
      {
        circleId, entryId: postId, kind: AttachmentKinds.POST_PHOTO, bytes: null, hash: 'h', keyVersion: 1,
        status: AttachmentStatuses.PENDING, fetchAttempts: 0, nextAttemptAt: null, createdAt: 1000,
      }
    );
  }

  return { circleId, postIds, authorKey };
}

function comment(postId: string, authorPublicKey: string, body: string, createdAt: number, id = generateUUID()) {
  return { id, postId, authorPublicKey, body, createdAt };
}

test('returns the newest comment and the total, not the whole thread', async () => {
  const { circleId, postIds, authorKey } = await circleWithPosts(1);
  const [postId] = postIds;
  await insertComment(comment(postId, authorKey, 'first', 1_000));
  await insertComment(comment(postId, authorKey, 'newest', 3_000));
  await insertComment(comment(postId, authorKey, 'middle', 2_000));

  const summary = (await getCommentSummaries(circleId, [postId])).get(postId);

  expect(summary?.total).toBe(3);
  expect(summary?.latest?.body).toBe('newest');
});

test('resolves the author from the roster, the same as the full thread does', async () => {
  const { circleId, postIds, authorKey } = await circleWithPosts(1);
  const [postId] = postIds;
  await updateMemberProfile(circleId, authorKey, { name: 'Marcus', picture: new Uint8Array([1, 2, 3]) });
  await insertComment(comment(postId, authorKey, 'hello', 1_000));

  const latest = (await getCommentSummaries(circleId, [postId])).get(postId)?.latest;

  expect(latest?.authorName).toBe('Marcus');
  expect(latest?.authorPicture).toEqual(new Uint8Array([1, 2, 3]));
});

/** The whole point of the batch: a feed of N posts costs two queries, not 2N. */
test('keeps each post to its own comments across a page of them', async () => {
  const { circleId, postIds, authorKey } = await circleWithPosts(3);
  const [first, second, third] = postIds;
  await insertComment(comment(first, authorKey, 'on first', 1_000));
  await insertComment(comment(second, authorKey, 'older on second', 1_000));
  await insertComment(comment(second, authorKey, 'newer on second', 2_000));

  const summaries = await getCommentSummaries(circleId, postIds);

  expect(summaries.get(first)).toMatchObject({ total: 1 });
  expect(summaries.get(first)?.latest?.body).toBe('on first');
  expect(summaries.get(second)?.total).toBe(2);
  expect(summaries.get(second)?.latest?.body).toBe('newer on second');
  // A post nobody has replied to is absent rather than holding an empty summary.
  expect(summaries.get(third)).toBeUndefined();
});

/**
 * Two comments can share a millisecond. Whichever is picked, every device
 * has to pick the same one or the same post reads differently on each.
 */
test('breaks a tie on the same timestamp deterministically', async () => {
  const { circleId, postIds, authorKey } = await circleWithPosts(1);
  const [postId] = postIds;
  await insertComment(comment(postId, authorKey, 'aaa wins', 5_000, 'aaa'));
  await insertComment(comment(postId, authorKey, 'zzz', 5_000, 'zzz'));

  const first = (await getCommentSummaries(circleId, [postId])).get(postId)?.latest?.id;
  const second = (await getCommentSummaries(circleId, [postId])).get(postId)?.latest?.id;

  expect(first).toBe('zzz');
  expect(second).toBe('zzz');
});

test('an empty page costs no query at all', async () => {
  const { circleId } = await circleWithPosts(0);

  expect((await getCommentSummaries(circleId, [])).size).toBe(0);
});
