jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  AttachmentKinds,
  AttachmentStatuses,
  addReaction,
  getPostReactionSummaries,
  getPostReactionSummary,
  getPostReactors,
  initDatabase,
  insertPost,
  MemberRoles,
  recordMemberAddedLocally,
  updateMemberProfile,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

async function circleWithPost() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const author = (await getCircleIdentity(circleId))!;
  const postId = generateUUID();
  await insertPost(
    { id: postId, circleId, caption: 'c', authorPublicKey: bytesToHex(author.publicKey), createdAt: 1000, lastViewedAt: null, inAlbum: true },
    {
      circleId, entryId: postId, kind: AttachmentKinds.POST_PHOTO, bytes: null, hash: 'h', keyVersion: 1,
      status: AttachmentStatuses.PENDING, fetchAttempts: 0, nextAttemptAt: null, createdAt: 1000,
    }
  );
  return { circleId, postId };
}

/** A member on the roster, so their reaction can resolve to a name. */
async function member(circleId: string, name: string) {
  const key = bytesToHex(generateIdentity().publicKey);
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: key,
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name, picture: null },
  });
  return key;
}

describe('getPostReactors', () => {
  test('lists everyone who reacted, in the order they did', async () => {
    const { circleId, postId } = await circleWithPost();
    const ro = await member(circleId, 'Aunt Ro');
    const dad = await member(circleId, 'Dad');
    const nana = await member(circleId, 'Nana');

    await addReaction({ postId, authorPublicKey: dad, emoji: '❤️', createdAt: 2_000 });
    await addReaction({ postId, authorPublicKey: ro, emoji: '❤️', createdAt: 1_000 });
    await addReaction({ postId, authorPublicKey: nana, emoji: '😭', createdAt: 3_000 });

    expect(await getPostReactors(circleId, postId)).toEqual(['Aunt Ro', 'Dad', 'Nana']);
  });

  /** The screen lists people, not reactions — two emoji from one person is still one person. */
  test('names someone once however many emoji they used', async () => {
    const { circleId, postId } = await circleWithPost();
    const theo = await member(circleId, 'Theo');
    const lena = await member(circleId, 'Lena');

    await addReaction({ postId, authorPublicKey: theo, emoji: '❤️', createdAt: 1_000 });
    await addReaction({ postId, authorPublicKey: theo, emoji: '🙏', createdAt: 2_000 });
    await addReaction({ postId, authorPublicKey: lena, emoji: '✨', createdAt: 3_000 });

    expect(await getPostReactors(circleId, postId)).toEqual(['Theo', 'Lena']);
  });

  /** The chips' counts still include them; a list padded with "Unknown member" reads worse than a short one. */
  test('omits a reactor this device has no roster row for', async () => {
    const { circleId, postId } = await circleWithPost();
    const known = await member(circleId, 'Priya');
    const stranger = bytesToHex(generateIdentity().publicKey);

    await addReaction({ postId, authorPublicKey: known, emoji: '🙏', createdAt: 1_000 });
    await addReaction({ postId, authorPublicKey: stranger, emoji: '🙏', createdAt: 2_000 });

    expect(await getPostReactors(circleId, postId)).toEqual(['Priya']);
  });

  test('resolves names live, so a rename reaches an old reaction', async () => {
    const { circleId, postId } = await circleWithPost();
    const key = await member(circleId, 'Tom');
    await addReaction({ postId, authorPublicKey: key, emoji: '✨', createdAt: 1_000 });

    await updateMemberProfile(circleId, key, { name: 'Tomás', picture: null });

    expect(await getPostReactors(circleId, postId)).toEqual(['Tomás']);
  });

  test('a post nobody reacted to has nobody', async () => {
    const { circleId, postId } = await circleWithPost();

    expect(await getPostReactors(circleId, postId)).toEqual([]);
  });

  test('ignores reactions on other posts', async () => {
    const { circleId, postId } = await circleWithPost();
    const other = await circleWithPost();
    const key = await member(circleId, 'Ruth');
    await addReaction({ postId: other.postId, authorPublicKey: key, emoji: '❤️', createdAt: 1_000 });

    expect(await getPostReactors(circleId, postId)).toEqual([]);
  });
});

/** The chips render in this order on both the feed and the post screen, so it can't be left to SQLite. */
test('the chip summary is ordered by when each emoji was first used', async () => {
  const { circleId, postId } = await circleWithPost();
  const a = await member(circleId, 'Lena');
  const b = await member(circleId, 'Tomás');
  const c = await member(circleId, 'Ruth');

  await addReaction({ postId, authorPublicKey: a, emoji: '🙏', createdAt: 3_000 });
  await addReaction({ postId, authorPublicKey: b, emoji: '❤️', createdAt: 1_000 });
  await addReaction({ postId, authorPublicKey: c, emoji: '😭', createdAt: 2_000 });

  const summary = await getPostReactionSummary(postId, a);

  expect(summary.map((row) => row.emoji)).toEqual(['❤️', '😭', '🙏']);
});

describe('getPostReactionSummaries', () => {
  /**
   * The batch exists only to save a query per post — if it ever disagreed
   * with the single-post version, the feed and the post screen would show
   * different chips for the same post.
   */
  test('matches the per-post summary, ordering included', async () => {
    const { circleId, postId } = await circleWithPost();
    const me = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
    const other = bytesToHex(generateIdentity().publicKey);
    await addReaction({ postId, authorPublicKey: other, emoji: '🙏', createdAt: 1_000 });
    await addReaction({ postId, authorPublicKey: me, emoji: '❤️', createdAt: 2_000 });
    await addReaction({ postId, authorPublicKey: other, emoji: '❤️', createdAt: 3_000 });

    const batched = (await getPostReactionSummaries([postId], me)).get(postId);

    expect(batched).toEqual(await getPostReactionSummary(postId, me));
    expect(batched).toEqual([
      { emoji: '🙏', count: 1, reactedByMe: false },
      { emoji: '❤️', count: 2, reactedByMe: true },
    ]);
  });

  test('keeps each post to its own reactions, and omits one with none', async () => {
    const { circleId, postId } = await circleWithPost();
    const { postId: quiet } = await circleWithPost();
    const me = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
    await addReaction({ postId, authorPublicKey: me, emoji: '❤️', createdAt: 1_000 });

    const summaries = await getPostReactionSummaries([postId, quiet], me);

    expect(summaries.get(postId)).toHaveLength(1);
    expect(summaries.get(quiet)).toBeUndefined();
  });

  test('an empty page costs no query at all', async () => {
    expect((await getPostReactionSummaries([], 'aa')).size).toBe(0);
  });
});
