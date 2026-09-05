import { generateUUID } from '@/services/crypto';
import { initDatabase } from '@/data/db';
import { AttachmentKinds, AttachmentStatuses, type NewAttachment } from '@/data/db/attachments';
import { insertComment } from '@/data/db/comments';
import { insertMember } from '@/data/db/members';
import { deleteCircle, insertCircle } from '@/data/db/circles';
import { getCircleFeed, getPost, getUnseenCommentPostIds, insertPost, markPostViewed } from '@/data/db/posts';

const OWN_KEY = 'aa'.repeat(32);
const OTHER_KEY = 'bb'.repeat(32);

beforeAll(() => initDatabase());

async function makeCircle() {
  const circle = { id: generateUUID(), name: 'Test Circle', picture: null, syncId: generateUUID(), createdAt: Date.now(), leftAt: null, metaCursor: 0, contentCursor: 0, lastViewedAt: 0 };
  await insertCircle(circle);
  return circle;
}

function makePost(circleId: string, overrides: Partial<{ caption: string; createdAt: number }> = {}) {
  return {
    id: generateUUID(),
    circleId,
    caption: overrides.caption ?? 'Nana in the kitchen.',
    authorPublicKey: 'aa'.repeat(32),
    createdAt: overrides.createdAt ?? Date.now(),
    lastViewedAt: null,
  };
}

/** The photo attachment a locally-created post carries: bytes already in hand, nothing to download. */
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

describe('posts CRUD', () => {
  test('getCircleFeed returns nothing before any post is inserted', async () => {
    const circle = await makeCircle();

    await expect(getCircleFeed(circle.id)).resolves.toEqual([]);
  });

  test('a post with no attachment yet reads back with no photo, rather than dropping out', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    await insertPost(post);

    const [stored] = await getCircleFeed(circle.id);
    expect(stored.id).toBe(post.id);
    expect(stored.hasPhoto).toBe(false);
    expect(stored.photoStatus).toBeNull();
  });

  test('insertPost with an attachment reads the photo bytes back on the post', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    await insertPost(post, makeAttachment(post));

    const [stored] = await getCircleFeed(circle.id);
    expect(stored.hasPhoto).toBe(true);
    expect(stored.photoStatus).toBe('fetched');
    expect(stored.createdAt).toBe(post.createdAt);
  });

  test('getCircleFeed resolves the author and photo without the join blanking the post', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id);
    await insertMember({
      circleId: circle.id,
      identityPublicKey: post.authorPublicKey,
      encPublicKey: 'bb',
      memberId: generateUUID(),
      role: 'admin',
      name: 'Priya Raman',
      picture: null,
      joinedAt: 100,
      removedAt: null,
    });
    await insertPost(post, makeAttachment(post));

    const [row] = await getCircleFeed(circle.id);

    expect(row.authorName).toBe('Priya Raman');
    expect(row.hasPhoto).toBe(true);
    // Regression guard for drizzle-team/drizzle-orm#555: joined columns
    // are emitted without AS aliases and this driver keys rows by column
    // name, so selecting any column whose name also exists on a joined
    // table silently overwrites this one. `createdAt` is the canary.
    expect(row.createdAt).toBe(post.createdAt);
  });

  test('getCircleFeed returns every post in a circle, newest first', async () => {
    const circle = await makeCircle();
    const earlier = makePost(circle.id, { caption: 'Earlier', createdAt: 1000 });
    const later = makePost(circle.id, { caption: 'Later', createdAt: 2000 });
    await insertPost(earlier);
    await insertPost(later);

    const posts = await getCircleFeed(circle.id);
    expect(posts.map((p) => p.id)).toEqual([later.id, earlier.id]);
  });

  test('deleting a circle cascades to its posts (ON DELETE CASCADE)', async () => {
    const circle = await makeCircle();
    await insertPost(makePost(circle.id));

    await deleteCircle(circle.id);

    await expect(getCircleFeed(circle.id)).resolves.toEqual([]);
  });
});

describe('markPostViewed / getUnseenCommentPostIds', () => {
  test('markPostViewed bumps lastViewedAt to roughly now', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id, { createdAt: 1000 });
    await insertPost(post);

    await markPostViewed(post.id);

    const stored = await getPost(post.id);
    expect(stored!.lastViewedAt).toBeGreaterThan(1000);
    expect(stored!.lastViewedAt).toBeLessThanOrEqual(Date.now());
  });

  test('a comment from someone else past the join floor makes its post unseen', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id, { createdAt: 500 });
    await insertPost(post);
    await insertComment({ id: generateUUID(), postId: post.id, authorPublicKey: OTHER_KEY, body: 'hey', createdAt: 2000 });

    await expect(getUnseenCommentPostIds(circle.id, OWN_KEY, 1000)).resolves.toEqual([post.id]);
  });

  test("excludes a post whose only new comment is the viewer's own", async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id, { createdAt: 500 });
    await insertPost(post);
    await insertComment({ id: generateUUID(), postId: post.id, authorPublicKey: OWN_KEY, body: 'hey', createdAt: 2000 });

    await expect(getUnseenCommentPostIds(circle.id, OWN_KEY, 1000)).resolves.toEqual([]);
  });

  test('excludes a comment predating the join floor, even on a never-viewed post', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id, { createdAt: 100 });
    await insertPost(post);
    await insertComment({ id: generateUUID(), postId: post.id, authorPublicKey: OTHER_KEY, body: 'hey', createdAt: 900 });

    await expect(getUnseenCommentPostIds(circle.id, OWN_KEY, 1000)).resolves.toEqual([]);
  });

  test('markPostViewed clears a post from the unseen list once its comments predate that view', async () => {
    const circle = await makeCircle();
    const post = makePost(circle.id, { createdAt: 500 });
    await insertPost(post);
    await insertComment({ id: generateUUID(), postId: post.id, authorPublicKey: OTHER_KEY, body: 'hey', createdAt: 2000 });
    await expect(getUnseenCommentPostIds(circle.id, OWN_KEY, 1000)).resolves.toEqual([post.id]);

    await markPostViewed(post.id);

    await expect(getUnseenCommentPostIds(circle.id, OWN_KEY, 1000)).resolves.toEqual([]);
  });
});
