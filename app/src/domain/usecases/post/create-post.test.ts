jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/relay');

import { decrypt, generateUUID, hashBytes, verify } from '@/services/crypto';
import { getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { getPendingOutboxEntries, initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { createPost } from '@/domain/usecases/post/create-post';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { getCircleFeed } from '@/data/db/posts';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { hexToBytes } from '@noble/curves/utils.js';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.clearAllMocks();
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

test('createPost triggers a drain of the circle it just posted to', async () => {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

  await createPost({ circleId, caption: 'Hello', photo: new Uint8Array([1]) });

  expect(drainOutbox).toHaveBeenCalledWith(circleId);
});

test('createPost still succeeds even if the triggered drain fails', async () => {
  (drainOutbox as jest.Mock).mockRejectedValue(new Error('offline'));
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

  await expect(createPost({ circleId, caption: 'Hello', photo: new Uint8Array([1]) })).resolves.toBeUndefined();
});

test('createPost queues an outbox entry whose encryptedMeta decrypts to a signed, verifiable post envelope', async () => {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

  const photo = new Uint8Array([1, 2, 3]);
  await createPost({ circleId, caption: 'Hello from the test', photo });

  const [post] = await getCircleFeed(circleId);
  const [entry] = await getPendingOutboxEntries(circleId);
  expect(entry.localId).toBe(post.id);

  const current = (await getCurrentContentKey(circleId))!;
  const envelope = JSON.parse(new TextDecoder().decode(decrypt(entry.encryptedMeta, current.key)));
  expect(envelope.type).toBe('post');
  expect(envelope.payload).toEqual({
    postId: post.id,
    caption: post.caption,
    photoHash: hashBytes(photo),
    createdAt: post.createdAt,
    keyVersion: current.version,
  });

  // The signature must verify against the envelope's own claimed author,
  // over the exact {type, payload} bytes — see log-entry.ts.
  const verified = verify(
    hexToBytes(envelope.signature),
    new TextEncoder().encode(JSON.stringify({ type: envelope.type, payload: envelope.payload })),
    hexToBytes(envelope.authorPubkey)
  );
  expect(verified).toBe(true);
});

test('createPost throws without a content key on this device', async () => {
  await expect(createPost({ circleId: generateUUID(), caption: 'x', photo: new Uint8Array([1]) })).rejects.toThrow();
});
