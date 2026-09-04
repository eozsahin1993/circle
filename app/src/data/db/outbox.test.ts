import { generateUUID } from '@/services/crypto';
import { initDatabase } from '@/data/db';
import { AttachmentKinds, AttachmentStatuses, type NewAttachment } from '@/data/db/attachments';
import { deleteCircle, insertCircle } from '@/data/db/circles';
import { getCircleFeed } from '@/data/db/posts';
import { getPendingOutboxEntries, insertPostAndEnqueue, markOutboxEntrySynced, type NewOutboxEntry } from '@/data/db/outbox';

beforeAll(() => initDatabase());

async function makeCircle() {
  const circle = { id: generateUUID(), name: 'Test Circle', picture: null, syncId: generateUUID(), createdAt: Date.now(), leftAt: null, metaCursor: 0, contentCursor: 0 };
  await insertCircle(circle);
  return circle;
}

function makePost(circleId: string) {
  return { id: generateUUID(), circleId, caption: 'Nana in the kitchen.', authorPublicKey: 'aa'.repeat(32), createdAt: Date.now() };
}

function makeAttachment(post: { id: string; circleId: string; createdAt: number }): NewAttachment {
  return {
    circleId: post.circleId,
    entryId: post.id,
    kind: AttachmentKinds.POST_PHOTO,
    bytes: new Uint8Array([1, 2, 3]),
    hash: 'deadbeef',
    keyVersion: 1,
    status: AttachmentStatuses.FETCHED,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt: post.createdAt,
  };
}

function makeOutboxEntry(circleId: string, entryId: string): NewOutboxEntry {
  return { circleId, entryType: 'post', entryId, status: 'pending', epoch: null, encryptedMeta: new Uint8Array([9, 9, 9]) };
}

describe('outbox', () => {
  test('getPendingOutboxEntries returns nothing before any entry is queued', async () => {
    const circle = await makeCircle();

    await expect(getPendingOutboxEntries(circle.id)).resolves.toEqual([]);
  });

  test('insertPostAndEnqueue queues a pending entry alongside the post', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);

    await insertPostAndEnqueue(post, makeAttachment(post), makeOutboxEntry(circle.id, post.id));

    const pending = await getPendingOutboxEntries(circle.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ circleId: circle.id, entryType: 'post', entryId: post.id, status: 'pending', epoch: null });
    expect(pending[0].encryptedMeta).toEqual(new Uint8Array([9, 9, 9]));

    const posts = await getCircleFeed(circle.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ id: post.id, caption: post.caption, createdAt: post.createdAt });
    // The attachment went in atomically with the post and the outbox row.
    expect(posts[0].hasPhoto).toBe(true);
  });

  test('pending entries come back in the exact order they were created', async () => {
    const circle = await makeCircle();
    const first = makePost(circle.id);
    const second = makePost(circle.id);
    const third = makePost(circle.id);
    await insertPostAndEnqueue(first, makeAttachment(first), makeOutboxEntry(circle.id, first.id));
    await insertPostAndEnqueue(second, makeAttachment(second), makeOutboxEntry(circle.id, second.id));
    await insertPostAndEnqueue(third, makeAttachment(third), makeOutboxEntry(circle.id, third.id));

    const pending = await getPendingOutboxEntries(circle.id);
    expect(pending.map((e) => e.entryId)).toEqual([first.id, second.id, third.id]);
  });

  test('markOutboxEntrySynced removes the entry from the pending list', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    await insertPostAndEnqueue(post, makeAttachment(post), makeOutboxEntry(circle.id, post.id));
    const [pending] = await getPendingOutboxEntries(circle.id);

    await markOutboxEntrySynced(pending.sequenceNum, 42);

    await expect(getPendingOutboxEntries(circle.id)).resolves.toEqual([]);
  });

  test('a failed enqueue rolls back the post too — never one without the other', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    const entryForNonexistentCircle = makeOutboxEntry(generateUUID(), post.id);

    await expect(insertPostAndEnqueue(post, makeAttachment(post), entryForNonexistentCircle)).rejects.toThrow();

    await expect(getCircleFeed(circle.id)).resolves.toEqual([]);
  });

  test('deleting a circle cascades to its outbox entries (ON DELETE CASCADE)', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    await insertPostAndEnqueue(post, makeAttachment(post), makeOutboxEntry(circle.id, post.id));

    await deleteCircle(circle.id);

    await expect(getPendingOutboxEntries(circle.id)).resolves.toEqual([]);
  });
});
