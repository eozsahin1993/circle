jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  AttachmentKinds,
  AttachmentStatuses,
  getPost,
  initDatabase,
  insertPost,
  MemberRoles,
  recordMemberAddedLocally,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { albumVisibilityHandler } from '@/sync/entry-handlers/album-visibility';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.resetAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'album_visibility', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

async function circleWithPost(inAlbum: boolean) {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const author = (await getCircleIdentity(circleId))!;
  const postId = generateUUID();
  await insertPost(
    { id: postId, circleId, caption: 'c', authorPublicKey: bytesToHex(author.publicKey), createdAt: 1000, lastViewedAt: null, inAlbum },
    {
      circleId, entryId: postId, kind: AttachmentKinds.POST_PHOTO, bytes: null, hash: 'h', keyVersion: 1,
      status: AttachmentStatuses.PENDING, fetchAttempts: 0, nextAttemptAt: null, createdAt: 1000,
    }
  );
  return { circleId, postId, author };
}

/** Adds someone to the roster who did not write the post. */
async function otherMember(circleId: string, role = MemberRoles.member) {
  const key = bytesToHex(generateIdentity().publicKey);
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: key,
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role, name: 'Marcus', picture: null },
  });
  return key;
}

describe('predicate', () => {
  test('accepts a change from the photo’s own author', async () => {
    const { circleId, postId, author } = await circleWithPost(true);

    await expect(
      albumVisibilityHandler.predicate(
        circleId,
        envelope(bytesToHex(author.publicKey), { postId, inAlbum: false, createdAt: 2000 })
      )
    ).resolves.toBe(true);
  });

  test('accepts a change from an admin who did not write the post', async () => {
    const { circleId, postId } = await circleWithPost(true);
    const admin = await otherMember(circleId, MemberRoles.admin);

    await expect(
      albumVisibilityHandler.predicate(circleId, envelope(admin, { postId, inAlbum: false, createdAt: 2000 }))
    ).resolves.toBe(true);
  });

  /** The rule's whole point: re-filing someone else's photo needs a reason to. */
  test('rejects a change from a plain member who did not write the post', async () => {
    const { circleId, postId } = await circleWithPost(true);
    const member = await otherMember(circleId);

    await expect(
      albumVisibilityHandler.predicate(circleId, envelope(member, { postId, inAlbum: false, createdAt: 2000 }))
    ).resolves.toBe(false);
  });

  /**
   * Authorship comes from the post's row, so a member who isn't an admin
   * can't pass on a post this device never applied — there's nothing to
   * match them against. (An admin still can; `apply` then updates nothing,
   * which the no-op test below covers.)
   */
  test('rejects a plain member’s change naming a post this device never applied', async () => {
    const { circleId } = await circleWithPost(true);
    const member = await otherMember(circleId);

    await expect(
      albumVisibilityHandler.predicate(
        circleId,
        envelope(member, { postId: generateUUID(), inAlbum: false, createdAt: 2000 })
      )
    ).resolves.toBe(false);
  });

  test('rejects a change from someone this device has never seen join', async () => {
    const { circleId, postId } = await circleWithPost(true);
    const stranger = generateIdentity();

    await expect(
      albumVisibilityHandler.predicate(
        circleId,
        envelope(bytesToHex(stranger.publicKey), { postId, inAlbum: false, createdAt: 2000 })
      )
    ).resolves.toBe(false);
  });

  test.each([
    ['a missing postId', { inAlbum: true, createdAt: 1 }],
    ['a non-boolean inAlbum', { postId: 'p', inAlbum: 'yes', createdAt: 1 }],
    ['a missing inAlbum', { postId: 'p', createdAt: 1 }],
    ['a non-numeric createdAt', { postId: 'p', inAlbum: true, createdAt: 'soon' }],
  ])('rejects %s even from a real member', async (_label, payload) => {
    const { circleId, author } = await circleWithPost(true);

    await expect(
      albumVisibilityHandler.predicate(circleId, envelope(bytesToHex(author.publicKey), payload))
    ).resolves.toBe(false);
  });
});

describe('apply', () => {
  test('takes a photo out of the album', async () => {
    const { circleId, postId, author } = await circleWithPost(true);

    await albumVisibilityHandler.apply(
      circleId,
      envelope(bytesToHex(author.publicKey), { postId, inAlbum: false, createdAt: 2000 }),
      1
    );

    expect((await getPost(postId))?.inAlbum).toBe(false);
  });

  test('puts one back in', async () => {
    const { circleId, postId, author } = await circleWithPost(false);

    await albumVisibilityHandler.apply(
      circleId,
      envelope(bytesToHex(author.publicKey), { postId, inAlbum: true, createdAt: 2000 }),
      1
    );

    expect((await getPost(postId))?.inAlbum).toBe(true);
  });

  /**
   * The log is append-only, so a change can only be superseded, never
   * retracted — replaying in epoch order is what makes every device agree
   * on which one came last, with no timestamps compared.
   */
  test('the last change replayed wins, whatever its payload timestamps say', async () => {
    const { circleId, postId, author } = await circleWithPost(true);
    const key = bytesToHex(author.publicKey);

    // Deliberately descending createdAt: only replay order should matter.
    await albumVisibilityHandler.apply(circleId, envelope(key, { postId, inAlbum: false, createdAt: 9000 }), 1);
    await albumVisibilityHandler.apply(circleId, envelope(key, { postId, inAlbum: true, createdAt: 2000 }), 2);

    expect((await getPost(postId))?.inAlbum).toBe(true);
  });

  test('a change naming a post this device skipped is a no-op, not a crash', async () => {
    const { circleId, author } = await circleWithPost(true);

    await expect(
      albumVisibilityHandler.apply(
        circleId,
        envelope(bytesToHex(author.publicKey), { postId: generateUUID(), inAlbum: false, createdAt: 2000 }),
        1
      )
    ).resolves.toBeUndefined();
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { circleId, postId, author } = await circleWithPost(true);

    await expect(
      albumVisibilityHandler.apply(circleId, envelope(bytesToHex(author.publicKey), { nonsense: true }), 1)
    ).resolves.toBeUndefined();

    expect((await getPost(postId))?.inAlbum).toBe(true);
  });
});
