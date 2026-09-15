jest.mock('@/core/services/log-relay');
jest.mock('@/features/account/usecases/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  addReaction,
  AttachmentKinds,
  AttachmentStatuses,
  getAttachment,
  getCircle,
  getCircleMemberEvents,
  getCircleMembers,
  getMemberByPublicKey,
  getPost,
  getPostComments,
  getPostReactionSummary,
  initDatabase,
  insertComment,
  insertPost,
  MemberRoles,
  recordMemberAddedLocally,
} from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { recordInManifestBestEffort } from '@/features/account/usecases/account-manifest';
import type { LogEntryEnvelope } from '@/core/sync/log-entry';
import { generateIdentity, generateUUID } from '@/core/crypto/primitives';
import { getCircleIdentity } from '@/core/services/keystore/circle-keys';
import { saveMasterSeed } from '@/core/services/keystore/master-seed';
import { appendEntry, bootstrapCircle } from '@/core/services/log-relay';
import { accountDeletedHandler } from '@/core/sync/entry-handlers/account-deleted';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (recordInManifestBestEffort as jest.Mock).mockResolvedValue(undefined);
});

function envelope(authorPubkey: string, payload: unknown = { createdAt: 2000 }): LogEntryEnvelope {
  return { type: 'account_deleted', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

/** Adds someone to the roster with no content yet. */
async function addMember(circleId: string, name: string) {
  const key = bytesToHex(generateIdentity().publicKey);
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: key,
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name, picture: null },
  });
  return key;
}

/**
 * A circle with two plain members besides this device's own founder
 * identity — `author` and `other` are both genuinely someone else, so
 * these tests exercise account-deleted's content-erasure and
 * roster-update logic without ever tripping its "this device's own
 * identity" self-purge branch (see the dedicated test for that).
 */
async function circleWithTwoAuthors() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const author = await addMember(circleId, 'Priya');
  const other = await addMember(circleId, 'Marcus');

  const ownPostId = generateUUID();
  await insertPost(
    {
      id: ownPostId,
      circleId,
      caption: 'mine',
      authorPublicKey: author,
      createdAt: 1000,
      lastViewedAt: null,
      inAlbum: true,
    },
    {
      circleId,
      entryId: ownPostId,
      kind: AttachmentKinds.POST_PHOTO,
      bytes: null,
      hash: 'h',
      keyVersion: 1,
      status: AttachmentStatuses.PENDING,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt: 1000,
    }
  );

  const othersPostId = generateUUID();
  await insertPost({ id: othersPostId, circleId, caption: 'theirs', authorPublicKey: other, createdAt: 1000, lastViewedAt: null, inAlbum: true });

  return { circleId, author, other, ownPostId, othersPostId };
}

describe('predicate', () => {
  test('accepts a deletion from a real member', async () => {
    const { circleId, author } = await circleWithTwoAuthors();

    await expect(accountDeletedHandler.predicate(circleId, envelope(author))).resolves.toBe(true);
  });

  test('rejects a deletion from someone this device has never seen join', async () => {
    const { circleId } = await circleWithTwoAuthors();
    const stranger = generateIdentity();

    await expect(accountDeletedHandler.predicate(circleId, envelope(bytesToHex(stranger.publicKey)))).resolves.toBe(
      false
    );
  });

  test('rejects a malformed payload even from a real member', async () => {
    const { circleId, author } = await circleWithTwoAuthors();

    await expect(accountDeletedHandler.predicate(circleId, envelope(author, { nonsense: true }))).resolves.toBe(
      false
    );
  });
});

describe('apply — content erasure', () => {
  test('deletes the author’s own posts, attachments included', async () => {
    const { circleId, author, ownPostId } = await circleWithTwoAuthors();

    await accountDeletedHandler.apply(circleId, envelope(author), 1);

    expect(await getPost(ownPostId)).toBeNull();
    expect(await getAttachment(circleId, ownPostId)).toBeNull();
  });

  test('leaves other members’ posts on the same circle untouched', async () => {
    const { circleId, author, othersPostId } = await circleWithTwoAuthors();

    await accountDeletedHandler.apply(circleId, envelope(author), 1);

    expect(await getPost(othersPostId)).not.toBeNull();
  });

  test('takes everyone’s comments and reactions on the author’s own post with it', async () => {
    const { circleId, author, other, ownPostId } = await circleWithTwoAuthors();
    await insertComment({ id: generateUUID(), postId: ownPostId, authorPublicKey: other, body: 'nice', createdAt: 1500 });
    await addReaction({ postId: ownPostId, authorPublicKey: other, emoji: '❤️', createdAt: 1500 });

    await accountDeletedHandler.apply(circleId, envelope(author), 1);

    expect(await getPostComments(circleId, ownPostId)).toEqual([]);
    expect(await getPostReactionSummary(ownPostId, other)).toEqual([]);
  });

  test('deletes the author’s own comments and reactions on someone else’s post, leaving that post and others’ comments alone', async () => {
    const { circleId, author, other, othersPostId } = await circleWithTwoAuthors();
    const otherComment = generateUUID();
    await insertComment({ id: generateUUID(), postId: othersPostId, authorPublicKey: author, body: 'love this', createdAt: 1500 });
    await insertComment({ id: otherComment, postId: othersPostId, authorPublicKey: other, body: 'agreed', createdAt: 1600 });
    await addReaction({ postId: othersPostId, authorPublicKey: author, emoji: '❤️', createdAt: 1500 });

    await accountDeletedHandler.apply(circleId, envelope(author), 1);

    expect(await getPost(othersPostId)).not.toBeNull();
    const comments = await getPostComments(circleId, othersPostId);
    expect(comments.map((c) => c.id)).toEqual([otherComment]);
    expect(await getPostReactionSummary(othersPostId, author)).toEqual([]);
  });

  test('applying the same deletion twice is a no-op', async () => {
    const { circleId, author } = await circleWithTwoAuthors();

    await accountDeletedHandler.apply(circleId, envelope(author), 1);

    await expect(accountDeletedHandler.apply(circleId, envelope(author), 2)).resolves.toBeUndefined();
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { circleId, author, ownPostId } = await circleWithTwoAuthors();

    await expect(accountDeletedHandler.apply(circleId, envelope(author, { nonsense: true }), 1)).resolves.toBeUndefined();

    expect(await getPost(ownPostId)).not.toBeNull();
  });
});

describe('apply — roster', () => {
  test('records an account_deleted history event, not removed', async () => {
    const { circleId, author, other } = await circleWithTwoAuthors();

    await accountDeletedHandler.apply(circleId, envelope(author, { createdAt: 2000 }), 5);

    const events = await getCircleMemberEvents(circleId);
    const own = events.find((e) => e.subjectPublicKey === author && e.kind === 'account_deleted');
    expect(own).toBeDefined();
    expect(own?.occurredAt).toBe(2000);
    expect(events.some((e) => e.subjectPublicKey === other)).toBe(false);
  });

  test('marks the author removed from the roster, leaving other members untouched', async () => {
    const { circleId, author, other } = await circleWithTwoAuthors();

    await accountDeletedHandler.apply(circleId, envelope(author), 1);

    expect(await getMemberByPublicKey(circleId, author)).toMatchObject({ removedAt: expect.any(Number) });
    expect((await getCircleMembers(circleId)).find((m) => m.identityPublicKey === other)).toBeDefined();
  });

  test('removing someone else’s account leaves this device fully in the circle', async () => {
    const { circleId, author } = await circleWithTwoAuthors();
    jest.clearAllMocks();

    await accountDeletedHandler.apply(circleId, envelope(author), 1);

    expect((await getCircle(circleId))?.leftAt).toBeNull();
    expect(await getCircleIdentity(circleId)).not.toBeNull();
    expect(recordInManifestBestEffort).not.toHaveBeenCalled();
  });

  /**
   * Another of this account's devices, still a member of this circle
   * when the deletion happened elsewhere — it has to clean itself up
   * exactly like leaving does, the same reason member-removed.ts's own
   * self-case exists.
   */
  test('the deleted identity being this device’s own cleans it up like leaving', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);
    jest.clearAllMocks();

    await accountDeletedHandler.apply(circleId, envelope(founderKey), 1);

    expect((await getCircle(circleId))?.leftAt).not.toBeNull();
    expect(await getCircleIdentity(circleId)).toBeNull();
    expect(recordInManifestBestEffort).toHaveBeenCalled();
  });
});
