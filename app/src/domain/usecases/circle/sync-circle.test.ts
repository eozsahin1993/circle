jest.mock('@/services/relay');

import { encryptJSON, generateUUID } from '@/services/crypto';
import { getCircleSecret, saveMasterSeed } from '@/services/keystore';
import { appendEntry, uploadBlob } from '@/services/relay';
import { getPendingOutboxEntries, initDatabase, insertPostAndEnqueue, OutboxStatuses, type Post } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => jest.clearAllMocks());

async function enqueuePost(circleId: string, secret: Uint8Array, photo: Uint8Array): Promise<Post> {
  const postId = generateUUID();
  const createdAt = Date.now();
  const encryptedMeta = encryptJSON({ postId, entryType: 'post', caption: 'hi', createdAt }, secret);
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

async function makeCircle() {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });
  const secret = (await getCircleSecret(circleId))!;
  return { circleId, secret };
}

test('drainOutbox appends the entry, uploads its blob, then marks it synced', async () => {
  const { circleId, secret } = await makeCircle();
  const post = await enqueuePost(circleId, secret, new Uint8Array([7, 7, 7]));
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 5, receivedAt: 999, upload: { url: 'https://s3', fields: {} } });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);

  await drainOutbox(circleId);

  expect(appendEntry).toHaveBeenCalledWith(expect.any(String), post.id, expect.any(Uint8Array));
  expect(uploadBlob).toHaveBeenCalledWith({ url: 'https://s3', fields: {} }, post.photo);
  await expect(getPendingOutboxEntries(circleId)).resolves.toEqual([]);
});

test('pushes multiple pending entries strictly in creation order', async () => {
  const { circleId, secret } = await makeCircle();
  const first = await enqueuePost(circleId, secret, new Uint8Array([1]));
  const second = await enqueuePost(circleId, secret, new Uint8Array([2]));
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: 1, upload: { url: 'https://s3', fields: {} } });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);

  await drainOutbox(circleId);

  const calls = (appendEntry as jest.Mock).mock.calls;
  expect(calls.map((call) => call[1])).toEqual([first.id, second.id]);
});

test('a failed append leaves the entry pending, and never attempts the blob upload', async () => {
  const { circleId, secret } = await makeCircle();
  await enqueuePost(circleId, secret, new Uint8Array([1]));
  (appendEntry as jest.Mock).mockRejectedValue(new Error('network down'));

  await expect(drainOutbox(circleId)).rejects.toThrow('network down');

  await expect(getPendingOutboxEntries(circleId)).resolves.toHaveLength(1);
  expect(uploadBlob).not.toHaveBeenCalled();
});

test('a failed blob upload leaves the entry pending too, even though the append already succeeded', async () => {
  const { circleId, secret } = await makeCircle();
  await enqueuePost(circleId, secret, new Uint8Array([1]));
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 5, receivedAt: 999, upload: { url: 'https://s3', fields: {} } });
  (uploadBlob as jest.Mock).mockRejectedValue(new Error('upload failed'));

  await expect(drainOutbox(circleId)).rejects.toThrow('upload failed');

  await expect(getPendingOutboxEntries(circleId)).resolves.toHaveLength(1);
});

test('throws without a circle secret on this device, and never calls the relay', async () => {
  await expect(drainOutbox(generateUUID())).rejects.toThrow();

  expect(appendEntry).not.toHaveBeenCalled();
});
