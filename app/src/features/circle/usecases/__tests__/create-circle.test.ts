jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/relay');

import { getAllCircles, getCircleMembers, initDatabase } from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { createPost } from '@/features/post/usecases/create-post';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { getCircleFeed } from '@/data/db/posts';
import { saveMasterSeed } from '@/core/services/keystore';
import { appendEntry, bootstrapCircle } from '@/core/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

test('createCircle inserts a circle and makes this device its first member', async () => {
  const { id } = await createCircle({ name: "Nana's House" });

  const circles = await getAllCircles();
  expect(circles).toContainEqual(expect.objectContaining({ id, name: "Nana's House" }));

  const members = await getCircleMembers(id);
  expect(members).toHaveLength(1);
  expect(members[0].role).toBe('admin');
});

test('createCircle then createPost end to end matches what the feed screen reads back', async () => {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

  await createPost({ circleId, caption: 'Hello from the test', photo: new Uint8Array([1, 2, 3]), inAlbum: true });

  const posts = await getCircleFeed(circleId);
  expect(posts).toHaveLength(1);
  expect(posts[0].caption).toBe('Hello from the test');
  expect(posts[0].hasPhoto).toBe(true);
});
