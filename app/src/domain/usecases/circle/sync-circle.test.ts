jest.mock('@/services/relay');

import { bytesToHex } from '@noble/curves/utils.js';

import { decrypt, generateUUID, hashBytes } from '@/services/crypto';
import { buildAndEncryptLogEntry } from '@/domain/usecases/circle/log-entry';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { appendEntry, BlobAlreadyExistsError, bootstrapCircle, getUploadTarget, uploadBlob } from '@/services/relay';
import {
  AttachmentKinds,
  AttachmentStatuses,
  getPendingOutboxEntries,
  initDatabase,
  insertPostAndEnqueue,
  OutboxStatuses,
  type Post,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  // resetAllMocks, not clearAllMocks: the latter clears recorded calls but
  // leaves implementations in place, so a mockRejectedValue from one test
  // stays armed for the next — which then fails somewhere unrelated (its
  // setup, usually) with a stale error.
  jest.resetAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

async function enqueuePost(circleId: string, photo: Uint8Array): Promise<Post> {
  const identity = (await getCircleIdentity(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;
  const postId = generateUUID();
  const createdAt = Date.now();
  const encryptedMeta = buildAndEncryptLogEntry('post', { postId, caption: 'hi', createdAt }, identity, current.key);
  const post = { id: postId, circleId, caption: 'hi', authorPublicKey: bytesToHex(identity.publicKey), createdAt };
  await insertPostAndEnqueue(
    post,
    {
      circleId,
      entryId: postId,
      kind: AttachmentKinds.POST_PHOTO,
      bytes: photo,
      hash: hashBytes(photo),
      keyVersion: current.version,
      status: AttachmentStatuses.FETCHED,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt,
    },
    {
      circleId,
      entryType: 'post',
      localId: postId,
      status: OutboxStatuses.pending,
      epoch: null,
      encryptedMeta,
    }
  );
  return post;
}

/**
 * Also clears the mocks right after creation — `createCircle` itself
 * calls `bootstrapCircle`/`appendEntry` internally (for the founder's own
 * `member_added` entry), and every test below asserts on drainOutbox's
 * *own* relay calls specifically, not that unrelated setup call.
 */
async function makeCircle() {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });
  const current = (await getCurrentContentKey(circleId))!;
  jest.clearAllMocks();
  return { circleId, contentKey: current.key };
}

test('drainOutbox obtains an upload target, uploads the blob, appends the entry, then marks it synced', async () => {
  const { circleId, contentKey } = await makeCircle();
  const photo = new Uint8Array([7, 7, 7]);
  const post = await enqueuePost(circleId, photo);
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 5, receivedAt: 999 });

  await drainOutbox(circleId);

  expect(getUploadTarget).toHaveBeenCalledWith(expect.any(String), post.id, expect.any(Uint8Array));
  const [uploadTarget, uploadedBytes] = (uploadBlob as jest.Mock).mock.calls[0];
  expect(uploadTarget).toEqual({ url: 'https://s3', fields: {} });
  expect(uploadedBytes).not.toEqual(photo);
  expect(decrypt(uploadedBytes, contentKey)).toEqual(photo);

  // Upload must happen before the append — see server/SYNC_DESIGN.md's
  // "Post" operation for why (an orphaned blob is recoverable; a log
  // entry pointing at nothing is not, since the log is immutable).
  const uploadOrder = (uploadBlob as jest.Mock).mock.invocationCallOrder[0];
  const appendOrder = (appendEntry as jest.Mock).mock.invocationCallOrder[0];
  expect(uploadOrder).toBeLessThan(appendOrder);

  expect(appendEntry).toHaveBeenCalledWith(expect.any(String), 'content', post.id, expect.any(Uint8Array), 1, expect.any(Uint8Array));
  await expect(getPendingOutboxEntries(circleId)).resolves.toEqual([]);
});

test('pushes multiple pending entries strictly in creation order', async () => {
  const { circleId } = await makeCircle();
  const first = await enqueuePost(circleId, new Uint8Array([1]));
  const second = await enqueuePost(circleId, new Uint8Array([2]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: 1 });

  await drainOutbox(circleId);

  const calls = (appendEntry as jest.Mock).mock.calls;
  expect(calls.map((call) => call[2])).toEqual([first.id, second.id]);
});

test('a retry that finds the blob already uploaded skips straight to the append', async () => {
  const { circleId } = await makeCircle();
  const post = await enqueuePost(circleId, new Uint8Array([1]));
  (getUploadTarget as jest.Mock).mockRejectedValue(new BlobAlreadyExistsError());
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 5, receivedAt: 999 });

  await drainOutbox(circleId);

  expect(uploadBlob).not.toHaveBeenCalled();
  expect(appendEntry).toHaveBeenCalledWith(expect.any(String), 'content', post.id, expect.any(Uint8Array), 1, expect.any(Uint8Array));
  await expect(getPendingOutboxEntries(circleId)).resolves.toEqual([]);
});

test('a failed upload leaves the entry pending, and never attempts the append', async () => {
  const { circleId } = await makeCircle();
  await enqueuePost(circleId, new Uint8Array([1]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockRejectedValue(new Error('upload failed'));

  await expect(drainOutbox(circleId)).rejects.toThrow('upload failed');

  await expect(getPendingOutboxEntries(circleId)).resolves.toHaveLength(1);
  expect(appendEntry).not.toHaveBeenCalled();
});

test('a failed append leaves the entry pending too, even though the upload already succeeded', async () => {
  const { circleId } = await makeCircle();
  await enqueuePost(circleId, new Uint8Array([1]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockRejectedValue(new Error('network down'));

  await expect(drainOutbox(circleId)).rejects.toThrow('network down');

  await expect(getPendingOutboxEntries(circleId)).resolves.toHaveLength(1);
});

test('throws without a content key on this device, and never calls the relay', async () => {
  await expect(drainOutbox(generateUUID())).rejects.toThrow();

  expect(appendEntry).not.toHaveBeenCalled();
});

test('concurrent drains of the same circle collapse into one push', async () => {
  // createPost and completeJoin both fire a drain, and every sync pass
  // runs one — so overlapping calls are routine, not exotic.
  const { circleId } = await makeCircle();
  await enqueuePost(circleId, new Uint8Array([1, 2, 3]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 5, receivedAt: 999 });

  await Promise.all([drainOutbox(circleId), drainOutbox(circleId), drainOutbox(circleId)]);

  // Without the guard all three would read the same pending row and push
  // it — the relay would dedupe, but after three uploads and appends.
  expect((appendEntry as jest.Mock).mock.calls).toHaveLength(1);
  expect((uploadBlob as jest.Mock).mock.calls).toHaveLength(1);
});

test('a later drain still runs once the first has finished', async () => {
  const { circleId } = await makeCircle();
  await enqueuePost(circleId, new Uint8Array([1, 2, 3]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 5, receivedAt: 999 });

  await drainOutbox(circleId);
  await enqueuePost(circleId, new Uint8Array([4, 5, 6]));
  await drainOutbox(circleId);

  // The guard must clear itself, or the second post would never go out.
  expect((appendEntry as jest.Mock).mock.calls).toHaveLength(2);
});

test('an entry queued while a drain is running still gets pushed by it', async () => {
  // Posting during a sync pass is routine. The second caller joins the
  // running drain rather than starting a rival one — but that drain had
  // already read its batch, so without a follow-up pass the new entry
  // would sit unsent until some later trigger happened along.
  const { circleId } = await makeCircle();
  await enqueuePost(circleId, new Uint8Array([1, 1, 1]));
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);

  let queuedDuringDrain = false;
  (appendEntry as jest.Mock).mockImplementation(async () => {
    if (!queuedDuringDrain) {
      queuedDuringDrain = true;
      await enqueuePost(circleId, new Uint8Array([2, 2, 2]));
      drainOutbox(circleId); // the fire-and-forget createPost makes
    }
    return { epoch: 1, receivedAt: 1 };
  });

  await drainOutbox(circleId);

  expect((appendEntry as jest.Mock).mock.calls).toHaveLength(2);
  expect(await getPendingOutboxEntries(circleId)).toHaveLength(0);
});
