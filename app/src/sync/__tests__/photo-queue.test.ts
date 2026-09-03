jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import {
  AttachmentKinds,
  AttachmentStatuses,
  getAttachment,
  getFetchableAttachments,
  initDatabase,
  insertPost,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { encrypt, generateUUID, hashBytes } from '@/services/crypto';
import { getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle, getBlob } from '@/services/relay';
import { drainPhotoQueue } from '@/sync/photo-queue';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

/** A pulled post: row present, photo not downloaded yet — exactly what the post handler writes. */
async function makePendingPost(circleId: string, photo: Uint8Array, createdAt: number) {
  const postId = generateUUID();
  await insertPost(
    { id: postId, circleId, caption: 'c', authorPublicKey: 'aa', createdAt },
    {
      circleId,
      entryId: postId,
      kind: AttachmentKinds.POST_PHOTO,
      bytes: null,
      hash: hashBytes(photo),
      keyVersion: 1,
      status: AttachmentStatuses.PENDING,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt,
    }
  );
  return postId;
}

test('downloads, decrypts, and stores a pending photo', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const key = (await getCurrentContentKey(circleId))!.key;
  const photo = new Uint8Array([4, 5, 6]);
  const postId = await makePendingPost(circleId, photo, 1000);
  (getBlob as jest.Mock).mockResolvedValue(encrypt(photo, key));

  await drainPhotoQueue();

  const attachment = await getAttachment(circleId, postId);
  expect(attachment?.bytes).toEqual(photo);
  expect(attachment?.status).toBe('fetched');
  expect(attachment?.fetchAttempts).toBe(0);
});

test('fetches newest first, across circles rather than finishing one circle at a time', async () => {
  const { id: olderCircle } = await createCircle({ name: 'Older' });
  const { id: newerCircle } = await createCircle({ name: 'Newer' });
  const photo = new Uint8Array([7]);
  await makePendingPost(olderCircle, photo, 1000);
  const newest = await makePendingPost(newerCircle, photo, 9000);
  await makePendingPost(olderCircle, photo, 2000);

  const [first] = await getFetchableAttachments(Date.now(), 1);

  // The newest photo wins even though its circle was created last and has
  // fewer pending items — an old backlog must never starve a fresh post.
  expect(first.entryId).toBe(newest);
});

test('records a failure with backoff and leaves the photo pending', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const postId = await makePendingPost(circleId, new Uint8Array([1]), 1000);
  (getBlob as jest.Mock).mockRejectedValue(new Error('offline'));

  await drainPhotoQueue();

  const attachment = await getAttachment(circleId, postId);
  expect(attachment?.status).toBe('failed');
  expect(attachment?.bytes).toBeNull();
  expect(attachment?.fetchAttempts).toBe(1);
  expect(attachment?.nextAttemptAt).toBeGreaterThan(Date.now());
});

test('a failed photo is skipped until its backoff expires, so the queue never spins on it', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await makePendingPost(circleId, new Uint8Array([1]), 1000);
  (getBlob as jest.Mock).mockRejectedValue(new Error('offline'));

  await drainPhotoQueue();
  const attemptsAfterFirstDrain = (getBlob as jest.Mock).mock.calls.length;
  // A second drain right away must not retry it — otherwise a permanently
  // broken newest photo would block every other photo forever.
  await drainPhotoQueue();

  expect((getBlob as jest.Mock).mock.calls.length).toBe(attemptsAfterFirstDrain);
  expect(await getFetchableAttachments(Date.now(), 1)).toHaveLength(0);
});

test('rejects bytes that do not match the hash the author signed', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const key = (await getCurrentContentKey(circleId))!.key;
  const postId = await makePendingPost(circleId, new Uint8Array([1, 1, 1]), 1000);
  // Correctly encrypted, so it decrypts — but they aren't the bytes the
  // signed entry committed to, which is the swap this check exists for.
  (getBlob as jest.Mock).mockResolvedValue(encrypt(new Uint8Array([2, 2, 2]), key));

  await drainPhotoQueue();

  const attachment = await getAttachment(circleId, postId);
  expect(attachment?.bytes).toBeNull();
  expect(attachment?.status).toBe('failed');
});

test('one failing photo does not stop the rest of the queue', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const key = (await getCurrentContentKey(circleId))!.key;
  const good = new Uint8Array([3, 3, 3]);
  const newestId = await makePendingPost(circleId, new Uint8Array([1]), 9000);
  const olderId = await makePendingPost(circleId, good, 1000);
  (getBlob as jest.Mock)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(encrypt(good, key));

  await drainPhotoQueue();

  expect((await getAttachment(circleId, newestId))?.status).toBe('failed');
  expect((await getAttachment(circleId, olderId))?.bytes).toEqual(good);
});

test('stops at the budget, for a background window that cannot run long', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const key = (await getCurrentContentKey(circleId))!.key;
  const photo = new Uint8Array([8]);
  await makePendingPost(circleId, photo, 3000);
  await makePendingPost(circleId, photo, 2000);
  await makePendingPost(circleId, photo, 1000);
  (getBlob as jest.Mock).mockResolvedValue(encrypt(photo, key));

  await drainPhotoQueue({ maxPhotos: 2 });

  expect((getBlob as jest.Mock).mock.calls.length).toBe(2);
  expect(await getFetchableAttachments(Date.now(), 5)).toHaveLength(1);
});
