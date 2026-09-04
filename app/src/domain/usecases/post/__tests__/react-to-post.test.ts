jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { AttachmentKinds, AttachmentStatuses, getPendingOutboxEntries, initDatabase, insertPost } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { verifyLogEntry } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { getReactionsForPost, toggleReaction } from '@/domain/usecases/post/react-to-post';
import { generateUUID } from '@/services/crypto';
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

test('toggling a reaction stores it and queues it together', async () => {
  const { id: circleId } = await createCircle({ name: 'C' });
  const me = (await getCircleIdentity(circleId))!;
  const postId = generateUUID();
  await insertPost(
    { id: postId, circleId, caption: 'c', authorPublicKey: bytesToHex(me.publicKey), createdAt: 1 },
    {
      circleId,
      entryId: postId,
      kind: AttachmentKinds.POST_PHOTO,
      bytes: null,
      hash: 'h',
      keyVersion: 1,
      status: AttachmentStatuses.PENDING,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt: 1,
    }
  );

  await toggleReaction(circleId, postId, '❤️');

  expect((await getReactionsForPost(circleId, postId))[0]).toMatchObject({ emoji: '❤️', reactedByMe: true });
  expect((await getPendingOutboxEntries(circleId)).filter((entry) => entry.entryType === 'reaction')).toHaveLength(1);

  // Drain what's queued so far, the way createPost's fire-and-forget does.
  await drainOutbox(circleId);
  await toggleReaction(circleId, postId, '❤️');

  expect(await getReactionsForPost(circleId, postId)).toHaveLength(0);

  // Un-reacting appends its own entry rather than cancelling the first —
  // the log can't retract, so the removal has to be said out loud.
  const queued = (await getPendingOutboxEntries(circleId)).filter((entry) => entry.entryType === 'reaction');
  expect(queued).toHaveLength(1);
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  expect(verifyLogEntry(queued[0].encryptedMeta, contentKey)).toMatchObject({
    payload: { emoji: '❤️', reacted: false },
  });
});
