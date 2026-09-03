jest.mock('@/services/relay');

import { decrypt, generateUUID } from '@/services/crypto';
import { buildAndEncryptLogEntry } from '@/domain/usecases/circle/log-entry';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { appendEntry, BlobAlreadyExistsError, bootstrapCircle, getUploadTarget, uploadBlob } from '@/services/relay';
import { getPendingOutboxEntries, initDatabase, insertPostAndEnqueue, OutboxStatuses, type Post } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
});

async function enqueuePost(circleId: string, photo: Uint8Array): Promise<Post> {
  const identity = (await getCircleIdentity(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;
  const postId = generateUUID();
  const createdAt = Date.now();
  const encryptedMeta = buildAndEncryptLogEntry('post', { postId, caption: 'hi', createdAt }, identity, current.key);
  const post = { id: postId, circleId, caption: 'hi', photo, createdAt };
  await insertPostAndEnqueue(post, {
    circleId,
    entryType: 'post',
    localId: postId,
    status: OutboxStatuses.pending,
    epoch: null,
    encryptedMeta,
  });
  return post;
}

/**
 * Also clears the mocks right after creation — `createCircle` itself
 * calls `bootstrapCircle`/`appendEntry` internally (for the founder's own
 * `member_added` entry), and every test below asserts on drainOutbox's
 * *own* relay calls specifically, not that unrelated setup call.
 */
async function makeCircle() {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });
  const current = (await getCurrentContentKey(circleId))!;
  jest.clearAllMocks();
  return { circleId, contentKey: current.key };
}

test('drainOutbox obtains an upload target, uploads the blob, appends the entry, then marks it synced', async () => {
  const { circleId, contentKey } = await makeCircle();
  const post = await enqueuePost(circleId, new Uint8Array([7, 7, 7]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 5, receivedAt: 999 });

  await drainOutbox(circleId);

  expect(getUploadTarget).toHaveBeenCalledWith(expect.any(String), post.id, expect.any(Uint8Array));
  const [uploadTarget, uploadedBytes] = (uploadBlob as jest.Mock).mock.calls[0];
  expect(uploadTarget).toEqual({ url: 'https://s3', fields: {} });
  expect(uploadedBytes).not.toEqual(post.photo);
  expect(decrypt(uploadedBytes, contentKey)).toEqual(post.photo);

  // Upload must happen before the append — see server/SYNC_DESIGN.md's
  // "Post" operation for why (an orphaned blob is recoverable; a log
  // entry pointing at nothing is not, since the log is immutable).
  const uploadOrder = (uploadBlob as jest.Mock).mock.invocationCallOrder[0];
  const appendOrder = (appendEntry as jest.Mock).mock.invocationCallOrder[0];
  expect(uploadOrder).toBeLessThan(appendOrder);

  expect(appendEntry).toHaveBeenCalledWith(expect.any(String), 'content', post.id, expect.any(Uint8Array), 1, expect.any(Uint8Array));
  await expect(getPendingOutboxEntries(circleId)).resolves.toEqual([]);
});

test('pushes multiple pending entries strictly in creation order', async () => {
  const { circleId } = await makeCircle();
  const first = await enqueuePost(circleId, new Uint8Array([1]));
  const second = await enqueuePost(circleId, new Uint8Array([2]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: 1 });

  await drainOutbox(circleId);

  const calls = (appendEntry as jest.Mock).mock.calls;
  expect(calls.map((call) => call[2])).toEqual([first.id, second.id]);
});

test('a retry that finds the blob already uploaded skips straight to the append', async () => {
  const { circleId } = await makeCircle();
  const post = await enqueuePost(circleId, new Uint8Array([1]));
  (getUploadTarget as jest.Mock).mockRejectedValue(new BlobAlreadyExistsError());
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 5, receivedAt: 999 });

  await drainOutbox(circleId);

  expect(uploadBlob).not.toHaveBeenCalled();
  expect(appendEntry).toHaveBeenCalledWith(expect.any(String), 'content', post.id, expect.any(Uint8Array), 1, expect.any(Uint8Array));
  await expect(getPendingOutboxEntries(circleId)).resolves.toEqual([]);
});

test('a failed upload leaves the entry pending, and never attempts the append', async () => {
  const { circleId } = await makeCircle();
  await enqueuePost(circleId, new Uint8Array([1]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockRejectedValue(new Error('upload failed'));

  await expect(drainOutbox(circleId)).rejects.toThrow('upload failed');

  await expect(getPendingOutboxEntries(circleId)).resolves.toHaveLength(1);
  expect(appendEntry).not.toHaveBeenCalled();
});

test('a failed append leaves the entry pending too, even though the upload already succeeded', async () => {
  const { circleId } = await makeCircle();
  await enqueuePost(circleId, new Uint8Array([1]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockRejectedValue(new Error('network down'));

  await expect(drainOutbox(circleId)).rejects.toThrow('network down');

  await expect(getPendingOutboxEntries(circleId)).resolves.toHaveLength(1);
});

test('throws without a content key on this device, and never calls the relay', async () => {
  await expect(drainOutbox(generateUUID())).rejects.toThrow();

  expect(appendEntry).not.toHaveBeenCalled();
});
