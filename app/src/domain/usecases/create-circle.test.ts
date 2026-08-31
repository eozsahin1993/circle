import { initDatabase } from '@/data/db';
import { getAllCircles, getCircleMembers } from '@/data/db';
import { createCircle } from '@/domain/usecases/create-circle';
import { createPost } from '@/domain/usecases/create-post';
import { getCirclePosts } from '@/data/db/posts';

beforeAll(() => initDatabase());

test('createCircle inserts a circle and makes this device its first member', async () => {
  const { id } = await createCircle({ name: "Nana's House" });

  const circles = await getAllCircles();
  expect(circles).toContainEqual(expect.objectContaining({ id, name: "Nana's House" }));

  const members = await getCircleMembers(id);
  expect(members).toHaveLength(1);
});

test('createCircle then createPost end to end matches what the feed screen reads back', async () => {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });

  await createPost({ circleId, caption: 'Hello from the test', photo: new Uint8Array([1, 2, 3]) });

  const posts = await getCirclePosts(circleId);
  expect(posts).toHaveLength(1);
  expect(posts[0].caption).toBe('Hello from the test');
  expect(posts[0].photo).toEqual(new Uint8Array([1, 2, 3]));
});
