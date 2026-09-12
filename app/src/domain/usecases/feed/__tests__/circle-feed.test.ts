jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { initDatabase, insertPost } from '@/data/db';
import { recordMemberAdded } from '@/data/db/member-events';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { FEED_PAGE_SIZE, loadCircleFeedMeta, loadCircleFeedPage } from '@/domain/usecases/feed/circle-feed';
import { generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.resetAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

async function makeCircle() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  return { circleId, authorPublicKey: bytesToHex(identity.publicKey) };
}

function post(circleId: string, authorPublicKey: string, createdAt: number) {
  return { id: generateUUID(), circleId, caption: 'c', authorPublicKey, createdAt, lastViewedAt: null, inAlbum: true };
}

async function addEvent(circleId: string, actorPublicKey: string, occurredAt: number, name: string) {
  await recordMemberAdded({
    circleId,
    epoch: Math.floor(occurredAt),
    subjectPublicKey: generateUUID(),
    actorPublicKey,
    occurredAt,
    profile: { encPublicKey: 'x', memberId: generateUUID(), role: 'member', name, picture: null },
  });
}

describe('loadCircleFeedMeta', () => {
  test("resolves the founder's own identity as an admin", async () => {
    const { circleId, authorPublicKey } = await makeCircle();

    const meta = await loadCircleFeedMeta(circleId);

    expect(meta.circleName).toBe('Family Circle');
    expect(meta.ownPublicKey).toBe(authorPublicKey);
    expect(meta.ownIsAdmin).toBe(true);
  });
});

describe('loadCircleFeedPage', () => {
  /** 15 posts, newest first: 1,000,000 down to 986,000 in steps of 1,000. */
  async function makeCircleWithPosts() {
    const { circleId, authorPublicKey } = await makeCircle();
    for (let i = 0; i < 15; i++) {
      await insertPost(post(circleId, authorPublicKey, 1_000_000 - i * 1_000));
    }
    return { circleId, authorPublicKey };
  }

  test('the first page is the newest `FEED_PAGE_SIZE` posts, newest first', async () => {
    const { circleId } = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);

    const page = await loadCircleFeedPage(circleId, meta, null);

    expect(page.posts).toHaveLength(FEED_PAGE_SIZE);
    expect(page.posts[0].post.createdAt).toBe(1_000_000);
    expect(page.posts[FEED_PAGE_SIZE - 1].post.createdAt).toBe(1_000_000 - (FEED_PAGE_SIZE - 1) * 1_000);
    expect(page.nextCursor).not.toBeNull();
  });

  test('the next page continues from the cursor and eventually exhausts', async () => {
    const { circleId } = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);

    const first = await loadCircleFeedPage(circleId, meta, null);
    const second = await loadCircleFeedPage(circleId, meta, first.nextCursor);

    expect(second.posts).toHaveLength(15 - FEED_PAGE_SIZE);
    expect(second.nextCursor).toBeNull();
    // No post appears on both pages.
    const seenIds = new Set([...first.posts, ...second.posts].map((view) => view.post.id));
    expect(seenIds.size).toBe(15);
  });

  test('an event older than the first page\'s oldest post is deferred to the next page', async () => {
    const { circleId, authorPublicKey } = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);
    const first = await loadCircleFeedPage(circleId, meta, null);
    // First page's floor is its oldest post's createdAt.
    const floor = first.posts[first.posts.length - 1].post.createdAt;

    await addEvent(circleId, authorPublicKey, floor + 500, 'NewEnough');
    await addEvent(circleId, authorPublicKey, floor - 500, 'TooOld');

    const withEvents = await loadCircleFeedPage(circleId, meta, null);
    expect(withEvents.events.map((e) => e.subjectName)).toEqual(['NewEnough']);

    const second = await loadCircleFeedPage(circleId, meta, withEvents.nextCursor);
    expect(second.events.map((e) => e.subjectName)).toEqual(['TooOld']);
  });

  test('an event exactly at the floor belongs to the page it bounds, not the next one', async () => {
    const { circleId, authorPublicKey } = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);
    const first = await loadCircleFeedPage(circleId, meta, null);
    const floor = first.posts[first.posts.length - 1].post.createdAt;

    await addEvent(circleId, authorPublicKey, floor, 'RightOnTheFloor');

    const withEvents = await loadCircleFeedPage(circleId, meta, null);
    expect(withEvents.events.map((e) => e.subjectName)).toEqual(['RightOnTheFloor']);

    const second = await loadCircleFeedPage(circleId, meta, withEvents.nextCursor);
    expect(second.events).toEqual([]);
  });

  test('the last page (no more posts) takes every remaining event, with no floor of its own', async () => {
    const { circleId, authorPublicKey } = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);
    const first = await loadCircleFeedPage(circleId, meta, null);

    // Older than every post in the circle, including the last page's own oldest.
    await addEvent(circleId, authorPublicKey, 1, 'AncientJoiner');

    const second = await loadCircleFeedPage(circleId, meta, first.nextCursor);
    expect(second.events.map((e) => e.subjectName)).toEqual(['AncientJoiner']);
    expect(second.nextCursor).toBeNull();
  });

  test('scopes reactions, comments and photo state to just this page\'s posts', async () => {
    const { circleId } = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);

    const page = await loadCircleFeedPage(circleId, meta, null);

    expect(page.posts).toHaveLength(FEED_PAGE_SIZE);
    for (const view of page.posts) {
      expect(view.reactions).toEqual([]);
      expect(view.comments).toEqual({ latest: null, total: 0 });
      expect(view.hasUnseenComments).toBe(false);
    }
  });
});
