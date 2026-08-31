import { generateUUID } from '@/services/crypto';
import { initDatabase } from '@/data/db';
import { deleteCircle, insertCircle } from '@/data/db/circles';
import { getCirclePosts, insertPost } from '@/data/db/posts';

beforeAll(() => initDatabase());

async function makeCircle() {
  const circle = { id: generateUUID(), name: 'Test Circle', createdAt: Date.now() };
  await insertCircle(circle);
  return circle;
}

function makePost(circleId: string, overrides: Partial<{ caption: string; createdAt: number }> = {}) {
  return {
    id: generateUUID(),
    circleId,
    caption: overrides.caption ?? 'Nana in the kitchen.',
    photo: new Uint8Array([1, 2, 3]),
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

describe('posts CRUD', () => {
  test('getCirclePosts returns nothing before any post is inserted', async () => {
    const circle = await makeCircle();

    await expect(getCirclePosts(circle.id)).resolves.toEqual([]);
  });

  test('insertPost then getCirclePosts returns it', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    await insertPost(post);

    await expect(getCirclePosts(circle.id)).resolves.toEqual([post]);
  });

  test('getCirclePosts returns every post in a circle, newest first', async () => {
    const circle = await makeCircle();
    const earlier = makePost(circle.id, { caption: 'Earlier', createdAt: 1000 });
    const later = makePost(circle.id, { caption: 'Later', createdAt: 2000 });
    await insertPost(earlier);
    await insertPost(later);

    const posts = await getCirclePosts(circle.id);
    expect(posts.map((p) => p.id)).toEqual([later.id, earlier.id]);
  });

  test('deleting a circle cascades to its posts (ON DELETE CASCADE)', async () => {
    const circle = await makeCircle();
    await insertPost(makePost(circle.id));

    await deleteCircle(circle.id);

    await expect(getCirclePosts(circle.id)).resolves.toEqual([]);
  });
});
