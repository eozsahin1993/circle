jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  AttachmentKinds,
  AttachmentStatuses,
  getPendingOutboxEntries,
  getPost,
  initDatabase,
  insertPost,
  MemberRoles,
  recordRoleChangedLocally,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { verifyLogEntry } from '@/domain/usecases/circle/log-entry';
import { setAlbumVisibility } from '@/domain/usecases/post/set-album-visibility';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
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

async function circleWithPost() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  const postId = generateUUID();
  await insertPost(
    { id: postId, circleId, caption: 'c', authorPublicKey: bytesToHex(identity.publicKey), createdAt: 1, lastViewedAt: null, inAlbum: true },
    {
      circleId, entryId: postId, kind: AttachmentKinds.POST_PHOTO, bytes: null, hash: 'h', keyVersion: 1,
      status: AttachmentStatuses.PENDING, fetchAttempts: 0, nextAttemptAt: null, createdAt: 1,
    }
  );
  return { circleId, postId, identity, contentKey };
}

test('takes a photo out of the album locally and queues the change together', async () => {
  const { circleId, postId, identity, contentKey } = await circleWithPost();

  await setAlbumVisibility(circleId, postId, false);

  expect((await getPost(postId))?.inAlbum).toBe(false);

  const pending = await getPendingOutboxEntries(circleId);
  const changes = pending.filter((entry) => entry.entryType === 'album_visibility');
  expect(changes).toHaveLength(1);
  expect(verifyLogEntry(changes[0].encryptedMeta, contentKey)).toMatchObject({
    type: 'album_visibility',
    authorPubkey: bytesToHex(identity.publicKey),
    payload: { postId, inAlbum: false },
  });
});

test('a fresh entryId per change, so re-adding is never read as a retry of the removal', async () => {
  const { circleId, postId } = await circleWithPost();
  // The drain this fires is deliberately not awaited, so a push that
  // resolves would clear the first entry out of `pending` before the
  // second is even written and the assertion below would see one entry
  // whether or not the ids differ. Hanging the push keeps both in view.
  (appendEntry as jest.Mock).mockReturnValue(new Promise(() => {}));

  await setAlbumVisibility(circleId, postId, false);
  await setAlbumVisibility(circleId, postId, true);

  const changes = (await getPendingOutboxEntries(circleId)).filter(
    (entry) => entry.entryType === 'album_visibility'
  );
  expect(new Set(changes.map((entry) => entry.entryId)).size).toBe(2);
  expect((await getPost(postId))?.inAlbum).toBe(true);
});

/**
 * The predicate every other device applies would reject this entry, so
 * queueing it would leave the change showing here and nowhere else.
 */
test('refuses a plain member re-filing someone else’s photo, and queues nothing', async () => {
  const { circleId, identity } = await circleWithPost();
  // Demote this device: the founder is an admin, and an admin may re-file
  // anything. The post below belongs to someone else.
  await recordRoleChangedLocally({
    circleId,
    subjectPublicKey: bytesToHex(identity.publicKey),
    role: MemberRoles.member,
  });
  const stranger = bytesToHex(generateIdentity().publicKey);
  const othersPost = generateUUID();
  await insertPost({
    id: othersPost, circleId, caption: 'c', authorPublicKey: stranger,
    createdAt: 1, lastViewedAt: null, inAlbum: true,
  });

  await expect(setAlbumVisibility(circleId, othersPost, false)).rejects.toThrow();

  expect((await getPost(othersPost))?.inAlbum).toBe(true);
  expect((await getPendingOutboxEntries(circleId)).filter((e) => e.entryType === 'album_visibility')).toHaveLength(0);
});

test('throws without a content key on this device, and changes nothing', async () => {
  const { postId } = await circleWithPost();

  await expect(setAlbumVisibility(generateUUID(), postId, false)).rejects.toThrow();

  expect((await getPost(postId))?.inAlbum).toBe(true);
});
