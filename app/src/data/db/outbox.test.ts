import { generateUUID } from '@/services/crypto';
import { initDatabase } from '@/data/db';
import { deleteCircle, insertCircle } from '@/data/db/circles';
import { getCirclePosts } from '@/data/db/posts';
import { getPendingOutboxEntries, insertPostAndEnqueue, markOutboxEntrySynced, type NewOutboxEntry } from '@/data/db/outbox';

beforeAll(() => initDatabase());

async function makeCircle() {
  const circle = { id: generateUUID(), name: 'Test Circle', picture: null, syncId: generateUUID(), createdAt: Date.now(), leftAt: null, metaCursor: 0, contentCursor: 0 };
  await insertCircle(circle);
  return circle;
}

function makePost(circleId: string) {
  return { id: generateUUID(), circleId, caption: 'Nana in the kitchen.', photo: new Uint8Array([1, 2, 3]), createdAt: Date.now() };
}

function makeOutboxEntry(circleId: string, localId: string): NewOutboxEntry {
  return { circleId, entryType: 'post', localId, status: 'pending', epoch: null, encryptedMeta: new Uint8Array([9, 9, 9]) };
}

describe('outbox', () => {
  test('getPendingOutboxEntries returns nothing before any entry is queued', async () => {
    const circle = await makeCircle();

    await expect(getPendingOutboxEntries(circle.id)).resolves.toEqual([]);
  });

  test('insertPostAndEnqueue queues a pending entry alongside the post', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);

    await insertPostAndEnqueue(post, makeOutboxEntry(circle.id, post.id));

    const pending = await getPendingOutboxEntries(circle.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ circleId: circle.id, entryType: 'post', localId: post.id, status: 'pending', epoch: null });
    expect(pending[0].encryptedMeta).toEqual(new Uint8Array([9, 9, 9]));

    const posts = await getCirclePosts(circle.id);
    expect(posts).toEqual([post]);
  });

  test('pending entries come back in the exact order they were created', async () => {
    const circle = await makeCircle();
    const first = makePost(circle.id);
    const second = makePost(circle.id);
    const third = makePost(circle.id);
    await insertPostAndEnqueue(first, makeOutboxEntry(circle.id, first.id));
    await insertPostAndEnqueue(second, makeOutboxEntry(circle.id, second.id));
    await insertPostAndEnqueue(third, makeOutboxEntry(circle.id, third.id));

    const pending = await getPendingOutboxEntries(circle.id);
    expect(pending.map((e) => e.localId)).toEqual([first.id, second.id, third.id]);
  });

  test('markOutboxEntrySynced removes the entry from the pending list', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    await insertPostAndEnqueue(post, makeOutboxEntry(circle.id, post.id));
    const [pending] = await getPendingOutboxEntries(circle.id);

    await markOutboxEntrySynced(pending.sequenceNum, 42);

    await expect(getPendingOutboxEntries(circle.id)).resolves.toEqual([]);
  });

  test('a failed enqueue rolls back the post too — never one without the other', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    const entryForNonexistentCircle = makeOutboxEntry(generateUUID(), post.id);

    await expect(insertPostAndEnqueue(post, entryForNonexistentCircle)).rejects.toThrow();

    await expect(getCirclePosts(circle.id)).resolves.toEqual([]);
  });

  test('deleting a circle cascades to its outbox entries (ON DELETE CASCADE)', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    await insertPostAndEnqueue(post, makeOutboxEntry(circle.id, post.id));

    await deleteCircle(circle.id);

    await expect(getPendingOutboxEntries(circle.id)).resolves.toEqual([]);
  });
});
