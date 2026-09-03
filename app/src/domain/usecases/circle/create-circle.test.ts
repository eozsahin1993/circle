jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/relay');

import { getAllCircles, getCircleMembers, initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { createPost } from '@/domain/usecases/post/create-post';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { getCircleFeed } from '@/data/db/posts';
import { saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

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

  await createPost({ circleId, caption: 'Hello from the test', photo: new Uint8Array([1, 2, 3]) });

  const posts = await getCircleFeed(circleId);
  expect(posts).toHaveLength(1);
  expect(posts[0].caption).toBe('Hello from the test');
  expect(posts[0].photo).toEqual(new Uint8Array([1, 2, 3]));
});
