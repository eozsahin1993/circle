import { decrypt, generateUUID } from '@/services/crypto';
import { getCircleSecret } from '@/services/keystore';
import { getPendingOutboxEntries, initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/create-circle';
import { createPost } from '@/domain/usecases/create-post';
import { getCirclePosts } from '@/data/db/posts';

beforeAll(() => initDatabase());

test('createPost queues an outbox entry whose encryptedMeta decrypts to the post envelope', async () => {
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
