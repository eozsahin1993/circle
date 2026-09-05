jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { AttachmentKinds, AttachmentStatuses, initDatabase, insertPost } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { getReactionsForPost } from '@/domain/usecases/post/react-to-post';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { reactionHandler } from '@/sync/entry-handlers/reaction';

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
  return { type: 'reaction', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

async function circleWithPost() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const author = (await getCircleIdentity(circleId))!;
  const postId = generateUUID();
  await insertPost(
    { id: postId, circleId, caption: 'c', authorPublicKey: bytesToHex(author.publicKey), createdAt: 1000, lastViewedAt: null },
    {
      circleId, entryId: postId, kind: AttachmentKinds.POST_PHOTO, bytes: null, hash: 'h', keyVersion: 1,
      status: AttachmentStatuses.PENDING, fetchAttempts: 0, nextAttemptAt: null, createdAt: 1000,
    }
  );
  return { circleId, postId, author };
}

test('applies a reaction from another member', async () => {
  const { circleId, postId, author } = await circleWithPost();
  const other = generateIdentity();

  await reactionHandler.apply(
    circleId,
    envelope(bytesToHex(other.publicKey), { postId, emoji: '❤️', reacted: true, createdAt: 1 })
  );

  const [summary] = await getReactionsForPost(circleId, postId);
  expect(summary).toMatchObject({ emoji: '❤️', count: 1 });
  // Someone else's reaction, so not attributed to this device.
  expect(summary.reactedByMe).toBe(false);
  expect(bytesToHex(author.publicKey)).not.toBe(bytesToHex(other.publicKey));
});

test('a later un-react supersedes the earlier reaction', async () => {
  const { circleId, postId } = await circleWithPost();
  const other = bytesToHex(generateIdentity().publicKey);

  await reactionHandler.apply(circleId, envelope(other, { postId, emoji: '❤️', reacted: true, createdAt: 1 }));
  await reactionHandler.apply(circleId, envelope(other, { postId, emoji: '❤️', reacted: false, createdAt: 2 }));

  // Replay order decides the final state — no timestamp comparison needed.
  expect(await getReactionsForPost(circleId, postId)).toHaveLength(0);
});

test('replaying the same reaction twice still counts once', async () => {
  const { circleId, postId } = await circleWithPost();
  const other = bytesToHex(generateIdentity().publicKey);
  const entry = envelope(other, { postId, emoji: '🎉', reacted: true, createdAt: 1 });

  await reactionHandler.apply(circleId, entry);
  await reactionHandler.apply(circleId, entry);

  expect((await getReactionsForPost(circleId, postId))[0].count).toBe(1);
});

test('un-reacting something never reacted to is a no-op', async () => {
  const { circleId, postId } = await circleWithPost();
  const other = bytesToHex(generateIdentity().publicKey);

  await expect(
    reactionHandler.apply(circleId, envelope(other, { postId, emoji: '👍', reacted: false, createdAt: 1 }))
  ).resolves.toBeUndefined();

  expect(await getReactionsForPost(circleId, postId)).toHaveLength(0);
});

test('rejects a reaction from someone this device has never seen join', async () => {
  const { circleId, postId } = await circleWithPost();
  const stranger = bytesToHex(generateIdentity().publicKey);

  await expect(
    reactionHandler.predicate(circleId, envelope(stranger, { postId, emoji: '❤️', reacted: true, createdAt: 1 }))
  ).resolves.toBe(false);
});

test.each([
  ['a missing reacted flag', { postId: 'p', emoji: '❤️', createdAt: 1 }],
  ['a non-boolean reacted', { postId: 'p', emoji: '❤️', reacted: 'yes', createdAt: 1 }],
  ['an empty emoji', { postId: 'p', emoji: '', reacted: true, createdAt: 1 }],
  ['a missing postId', { emoji: '❤️', reacted: true, createdAt: 1 }],
])('rejects %s even from a real member', async (_label, payload) => {
  const { circleId, author } = await circleWithPost();

  await expect(reactionHandler.predicate(circleId, envelope(bytesToHex(author.publicKey), payload))).resolves.toBe(
    false
  );
});
