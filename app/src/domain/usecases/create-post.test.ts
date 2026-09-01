jest.mock('@/domain/usecases/sync-circle');

import { decrypt, generateUUID } from '@/services/crypto';
import { getCircleSecret } from '@/services/keystore';
import { getPendingOutboxEntries, initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/create-circle';
import { createPost } from '@/domain/usecases/create-post';
import { drainOutbox } from '@/domain/usecases/sync-circle';
import { getCirclePosts } from '@/data/db/posts';

beforeAll(() => initDatabase());
beforeEach(() => jest.clearAllMocks());

test('createPost triggers a drain of the circle it just posted to', async () => {
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

  await createPost({ circleId, caption: 'Hello', photo: new Uint8Array([1]) });

  expect(drainOutbox).toHaveBeenCalledWith(circleId);
});

test('createPost still succeeds even if the triggered drain fails', async () => {
  (drainOutbox as jest.Mock).mockRejectedValue(new Error('offline'));
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

  await expect(createPost({ circleId, caption: 'Hello', photo: new Uint8Array([1]) })).resolves.toBeUndefined();
});

test('createPost queues an outbox entry whose encryptedMeta decrypts to the post envelope', async () => {
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

  await createPost({ circleId, caption: 'Hello from the test', photo: new Uint8Array([1, 2, 3]) });

  const [post] = await getCirclePosts(circleId);
  const [entry] = await getPendingOutboxEntries(circleId);
  expect(entry.localId).toBe(post.id);

  const secret = await getCircleSecret(circleId);
  const envelope = JSON.parse(new TextDecoder().decode(decrypt(entry.encryptedMeta, secret!)));
  expect(envelope).toEqual({ postId: post.id, entryType: 'post', caption: post.caption, createdAt: post.createdAt });
});

test('createPost throws without a circle secret on this device', async () => {
  await expect(createPost({ circleId: generateUUID(), caption: 'x', photo: new Uint8Array([1]) })).rejects.toThrow();
});
