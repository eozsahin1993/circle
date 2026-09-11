jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  AttachmentKinds,
  AttachmentStatuses,
  getCommentAuthors,
  initDatabase,
  insertComment,
  insertPost,
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

describe('getCommentAuthors', () => {
  test('a post with no comments has no authors', async () => {
    const { postId } = await circleWithPost();

    expect(await getCommentAuthors(postId)).toEqual([]);
  });

  test('names each distinct commenter once, however many comments they left', async () => {
    const { postId } = await circleWithPost();
    const ro = bytesToHex(generateIdentity().publicKey);
    const dad = bytesToHex(generateIdentity().publicKey);

    await insertComment({ id: generateUUID(), postId, authorPublicKey: dad, body: 'nice', createdAt: 1_000 });
    await insertComment({ id: generateUUID(), postId, authorPublicKey: ro, body: 'lovely', createdAt: 2_000 });
    await insertComment({ id: generateUUID(), postId, authorPublicKey: dad, body: 'again', createdAt: 3_000 });

    expect([...(await getCommentAuthors(postId))].sort()).toEqual([dad, ro].sort());
  });

  test("ignores another post's comments", async () => {
    const { postId } = await circleWithPost();
    const { postId: otherPost } = await circleWithPost();
    const stranger = bytesToHex(generateIdentity().publicKey);
    await insertComment({ id: generateUUID(), postId: otherPost, authorPublicKey: stranger, body: 'hi', createdAt: 1_000 });

    expect(await getCommentAuthors(postId)).toEqual([]);
  });
});
