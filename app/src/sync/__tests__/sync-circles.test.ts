jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/mailbox-relay');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleFeed, getCircleMembers, getPostComments, initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { approveJoinRequest, getOrCreateInvite } from '@/domain/usecases/circle/invite-to-circle';
import type { JoinRequestPayload } from '@/domain/usecases/circle/invite-payloads';
import { buildAndEncryptLogEntry, verifyLogEntry } from '@/domain/usecases/circle/log-entry';
import { addComment } from '@/domain/usecases/post/comment-on-post';
import { createPost } from '@/domain/usecases/post/create-post';
import { getReactionsForPost, toggleReaction } from '@/domain/usecases/post/react-to-post';
import {
  deriveJoinRequestKey,
  encrypt,
  encryptJSON,
  generateEphemeralKeypair,
  generateIdentity,
  generateUUID,
  hashBytes,
} from '@/services/crypto';
import { listJoinRequests, putInvitePreview, putJoinApproval } from '@/services/mailbox-relay';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import {
  appendEntry,
  bootstrapCircle,
  fetchEntries,
  getBlob,
  getUploadTarget,
  uploadBlob,
  type Namespace,
} from '@/services/relay';
import { memberAddedHandler } from '@/sync/entry-handlers/member-added';
import { drainPhotoQueue } from '@/sync/photo-queue';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { syncCircle } from '@/sync/sync-circles';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });
  (putInvitePreview as jest.Mock).mockResolvedValue(undefined);
});

/**
 * Stands in for the relay: serves `meta`/`content` entries per namespace,
 * so one process can play "the other device already wrote these".
 */
function relayServes(byNamespace: { meta?: unknown[]; content?: unknown[] }) {
  (fetchEntries as jest.Mock).mockImplementation(async (_syncId: string, namespace: Namespace) => {
    const entries = (byNamespace[namespace] ?? []) as { epoch: number }[];
    return { entries, currentEpoch: entries.length > 0 ? entries[entries.length - 1].epoch : 0 };
  });
}

test('syncCircle picks up another member and their post, photo and all', async () => {
  // This device founds the circle; a second member and their post arrive
  // over the log — the gap createCircle/completeJoin both document as
  // "existing members only learn of this once pullCircle exists".
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;

  const other = generateIdentity();
  const postId = generateUUID();
  const photo = new Uint8Array([9, 9, 9]);

  relayServes({
    meta: [
      {
        epoch: 2,
        keyVersion: 1,
        receivedAt: Date.now(),
        // Signed by the founder — the approver, as the design intends.
        encryptedMeta: buildAndEncryptLogEntry(
          'member_added',
          { identityPublicKey: bytesToHex(other.publicKey), encPublicKey: 'cc', name: 'Marcus', role: 'member' },
          founder,
          contentKey
        ),
      },
    ],
    content: [
      {
        epoch: 1,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'post',
          { postId, caption: 'From the other device', photoHash: hashBytes(photo), createdAt: 8000, keyVersion: 1 },
          other,
          contentKey
        ),
      },
    ],
  });

  await syncCircle(circleId);

  const members = await getCircleMembers(circleId);
  expect(members.map((member) => member.name)).toContain('Marcus');

  const [post] = await getCircleFeed(circleId);
  expect(post).toMatchObject({ caption: 'From the other device', authorName: 'Marcus' });
  // The log pass deliberately does not download photos.
  expect(post.photo).toBeNull();
  expect(post.photoStatus).toBe('pending');

  (getBlob as jest.Mock).mockResolvedValue(encrypt(photo, contentKey));
  await drainPhotoQueue();

  const [withPhoto] = await getCircleFeed(circleId);
  expect(withPhoto.photo).toEqual(photo);
});

test('syncCircle pushes the queued posts this device made while pulling', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await createPost({ circleId, caption: 'Mine', photo: new Uint8Array([1, 2, 3]) });
  (appendEntry as jest.Mock).mockClear();

  await syncCircle(circleId);

  // Nothing outstanding to push after a pass that drained the outbox.
  const appendedTypes = (appendEntry as jest.Mock).mock.calls.map((call) => call[1]);
  expect(appendedTypes).toEqual(expect.arrayContaining(['content']));
});

test('meta is fully caught up before any content entry is read', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const order: Namespace[] = [];
  (fetchEntries as jest.Mock).mockImplementation(async (_syncId: string, namespace: Namespace) => {
    order.push(namespace);
    return { entries: [], currentEpoch: 0 };
  });

  await syncCircle(circleId);

  // A content entry needs its key version and its author, both of which
  // only meta can supply — so the order here is load-bearing, not stylistic.
  expect(order).toEqual(['meta', 'content']);
});

test('a post this device just pushed comes straight back on the same pass without duplicating', async () => {
  // pullContent runs after drainOutbox, so our own freshly-appended entry
  // is in the very next page the relay serves. It must be absorbed as a
  // no-op, not re-materialized or reset to pending.
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  const photo = new Uint8Array([1, 2, 3]);
  await createPost({ circleId, caption: 'Mine', photo });

  const [{ id: postId }] = await getCircleFeed(circleId);
  relayServes({
    content: [
      {
        epoch: 1,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'post',
          { postId, caption: 'Mine', photoHash: hashBytes(photo), createdAt: 1, keyVersion: 1 },
          founder,
          contentKey
        ),
      },
    ],
  });

  await syncCircle(circleId);

  const feed = await getCircleFeed(circleId);
  expect(feed).toHaveLength(1);
  // Still holds its local bytes — the echo must not blank them back to
  // 'pending' and send the download queue chasing a photo we authored.
  expect(feed[0].photo).toEqual(photo);
  expect(feed[0].photoStatus).toBe('fetched');
});

test('approving a join makes the new member visible to everyone, not just to the approver', async () => {
  // The gap this closes: previously the joiner announced itself, and every
  // other device discarded that entry because nobody had vouched for the
  // signer. Now the approver — an admin — writes it.
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  const joiner = generateIdentity();
  const joinerKey = bytesToHex(joiner.publicKey);

  const invite = await getOrCreateInvite(circleId);
  const requestPayload: JoinRequestPayload = {
    ephemeralPublicKey: bytesToHex(generateEphemeralKeypair().publicKey),
    identityPublicKey: joinerKey,
    encPublicKey: 'cc'.repeat(32),
    selfReportedName: 'Marcus',
  };
  (listJoinRequests as jest.Mock).mockResolvedValue([
    {
      requesterId: 'req-1',
      encryptedRequest: encryptJSON(requestPayload, deriveJoinRequestKey(invite.code)),
      encryptedApproval: null,
      createdAt: Date.now(),
    },
  ]);
  (putJoinApproval as jest.Mock).mockResolvedValue(undefined);

  await approveJoinRequest(circleId, 'req-1');
  // approveJoinRequest kicks the push off fire-and-forget so approval
  // never blocks on the network; await it here to assert on what lands.
  await drainOutbox(circleId);

  // Visible locally straight away, rather than only after a sync pass.
  const members = await getCircleMembers(circleId);
  expect(members.map((member) => member.identityPublicKey)).toContain(joinerKey);

  // And the entry that tells everyone else was appended, signed by the
  // approver so their predicate accepts it.
  const metaAppends = (appendEntry as jest.Mock).mock.calls.filter((call) => call[1] === 'meta');
  expect(metaAppends.length).toBeGreaterThan(0);
  const appended = verifyLogEntry(metaAppends[metaAppends.length - 1][3], contentKey);
  expect(appended).toMatchObject({
    type: 'member_added',
    authorPubkey: bytesToHex(founder.publicKey),
    payload: { identityPublicKey: joinerKey, name: 'Marcus', role: 'member' },
  });
});

test('a comment written here is pushed, and one from another device arrives', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  await createPost({ circleId, caption: 'Mine', photo: new Uint8Array([1, 2, 3]) });
  const [{ id: postId }] = await getCircleFeed(circleId);

  // Written here: lands locally and goes out to the relay as content.
  await addComment(circleId, postId, 'Nice one');
  (appendEntry as jest.Mock).mockClear();
  await drainOutbox(circleId);

  // The post's own entry may still have been queued, so look for the
  // comment among what went out rather than assuming it was alone.
  const pushed = (appendEntry as jest.Mock).mock.calls
    .filter((call) => call[1] === 'content')
    .map((call) => verifyLogEntry(call[3], contentKey));
  expect(pushed.filter((entry) => entry?.type === 'comment')).toEqual([
    expect.objectContaining({
      authorPubkey: bytesToHex(founder.publicKey),
      payload: expect.objectContaining({ postId, body: 'Nice one' }),
    }),
  ]);

  // Arriving from elsewhere: applied on the next content pass.
  const other = generateIdentity();
  await memberAddedHandler.apply(
    circleId,
    {
      type: 'member_added',
      payload: { identityPublicKey: bytesToHex(other.publicKey), encPublicKey: 'cc', name: 'Marcus', role: 'member' },
      authorPubkey: bytesToHex(founder.publicKey),
      signature: 'unused',
    },
  );
  relayServes({
    content: [
      {
        epoch: 9,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'comment',
          { commentId: generateUUID(), postId, body: 'From Marcus', createdAt: 8000 },
          other,
          contentKey
        ),
      },
    ],
  });

  await syncCircle(circleId);

  const comments = await getPostComments(circleId, postId);
  expect(comments.map((c) => c.body)).toEqual(expect.arrayContaining(['Nice one', 'From Marcus']));
  // Names resolve from the roster, not from anything stored on the comment.
  expect(comments.find((c) => c.body === 'From Marcus')?.authorName).toBe('Marcus');
});

test('a reaction toggled here is pushed, and one from another device arrives', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  await createPost({ circleId, caption: 'Mine', photo: new Uint8Array([1, 2, 3]) });
  const [{ id: postId }] = await getCircleFeed(circleId);

  await toggleReaction(circleId, postId, '❤️');
  (appendEntry as jest.Mock).mockClear();
  await drainOutbox(circleId);

  const pushed = (appendEntry as jest.Mock).mock.calls
    .filter((call) => call[1] === 'content')
    .map((call) => verifyLogEntry(call[3], contentKey));
  expect(pushed.filter((entry) => entry?.type === 'reaction')).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ postId, emoji: '❤️', reacted: true }) }),
  ]);

  const other = generateIdentity();
  await memberAddedHandler.apply(circleId, {
    type: 'member_added',
    payload: { identityPublicKey: bytesToHex(other.publicKey), encPublicKey: 'cc', name: 'Marcus', role: 'member' },
    authorPubkey: bytesToHex(founder.publicKey),
    signature: 'unused',
  });
  relayServes({
    content: [
      {
        epoch: 9,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'reaction',
          { postId, emoji: '❤️', reacted: true, createdAt: 9000 },
          other,
          contentKey
        ),
      },
    ],
  });

  await syncCircle(circleId);

  const [summary] = await getReactionsForPost(circleId, postId);
  expect(summary).toMatchObject({ emoji: '❤️', count: 2, reactedByMe: true });
});
