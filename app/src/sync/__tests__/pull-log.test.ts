jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircle, getCircleFeed, getCircleMembers, initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { buildAndEncryptLogEntry } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID, hashBytes } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle, fetchEntries, type LogEntry } from '@/services/relay';
import { pullContent, pullMeta } from '@/sync/pull-log';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

/** A circle whose cursors are both 0, so a pull walks everything the relay returns. */
async function makeCircle() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;
  return { circleId, identity, contentKey: current.key, keyVersion: current.version };
}

function entry(epoch: number, encryptedMeta: Uint8Array, keyVersion = 1): LogEntry {
  return { epoch, keyVersion, encryptedMeta, receivedAt: Date.now() };
}

/** One page containing `entries`, with the relay reporting no more beyond them. */
function onePage(entries: LogEntry[]) {
  (fetchEntries as jest.Mock).mockResolvedValue({
    entries,
    currentEpoch: entries.length > 0 ? entries[entries.length - 1].epoch : 0,
  });
}

describe('pullMeta', () => {
  test('applies a member_added from an existing admin and advances the cursor', async () => {
    const { circleId, identity, contentKey } = await makeCircle();
    const joiner = generateIdentity();
    // Signed by the founder, who createCircle already made an admin.
    const encrypted = buildAndEncryptLogEntry(
      'member_added',
      { identityPublicKey: bytesToHex(joiner.publicKey), encPublicKey: 'cc', name: 'Priya Raman', role: 'member' },
      identity,
      contentKey
    );
    onePage([entry(7, encrypted)]);

    await pullMeta(circleId);

    const members = await getCircleMembers(circleId);
    expect(members.map((member) => member.name)).toContain('Priya Raman');
    await expect(getCircle(circleId)).resolves.toMatchObject({ metaCursor: 7 });
  });

  test('discards a member_added signed by a non-admin, but still walks past it', async () => {
    const { circleId, contentKey } = await makeCircle();
    const stranger = generateIdentity();
    const joiner = generateIdentity();
    const encrypted = buildAndEncryptLogEntry(
      'member_added',
      { identityPublicKey: bytesToHex(joiner.publicKey), encPublicKey: 'cc', name: 'Uninvited', role: 'member' },
      stranger,
      contentKey
    );
    onePage([entry(3, encrypted)]);

    await pullMeta(circleId);

    const members = await getCircleMembers(circleId);
    expect(members.map((member) => member.name)).not.toContain('Uninvited');
    // Walked past: a permanently-invalid entry must never wedge the circle.
    await expect(getCircle(circleId)).resolves.toMatchObject({ metaCursor: 3 });
  });

  test('skips an entry encrypted under a key version this device does not hold', async () => {
    const { circleId, identity, contentKey } = await makeCircle();
    const joiner = generateIdentity();
    const encrypted = buildAndEncryptLogEntry(
      'member_added',
      { identityPublicKey: bytesToHex(joiner.publicKey), encPublicKey: 'cc', name: 'Future', role: 'member' },
      identity,
      contentKey
    );
    onePage([entry(4, encrypted, 9)]);

    await pullMeta(circleId);

    expect(await getCircleMembers(circleId)).toHaveLength(1);
    await expect(getCircle(circleId)).resolves.toMatchObject({ metaCursor: 4 });
  });

  test('applying the same entry twice is a no-op, not a duplicate member', async () => {
    const { circleId, identity, contentKey } = await makeCircle();
    const joiner = generateIdentity();
    const encrypted = buildAndEncryptLogEntry(
      'member_added',
      { identityPublicKey: bytesToHex(joiner.publicKey), encPublicKey: 'cc', name: 'Priya Raman', role: 'member' },
      identity,
      contentKey
    );
    onePage([entry(7, encrypted)]);

    await pullMeta(circleId);
    // A crash between applying and advancing replays the same entry.
    await pullMeta(circleId);

    expect(await getCircleMembers(circleId)).toHaveLength(2);
  });

  test('a fetch failure leaves the cursor where the last completed page left it', async () => {
    const { circleId, identity, contentKey } = await makeCircle();
    const joiner = generateIdentity();
    const encrypted = buildAndEncryptLogEntry(
      'member_added',
      { identityPublicKey: bytesToHex(joiner.publicKey), encPublicKey: 'cc', name: 'Priya Raman', role: 'member' },
      identity,
      contentKey
    );
    // First page succeeds and reports more to come; the follow-up throws.
    (fetchEntries as jest.Mock)
      .mockResolvedValueOnce({ entries: [entry(2, encrypted)], currentEpoch: 50 })
      .mockRejectedValueOnce(new Error('offline'));

    await expect(pullMeta(circleId)).rejects.toThrow('offline');

    // Progress from the completed page is kept, so the next pass resumes
    // from 2 rather than restarting at 0.
    await expect(getCircle(circleId)).resolves.toMatchObject({ metaCursor: 2 });
  });

  test('keeps paging until the cursor reaches the relay-reported latest epoch', async () => {
    const { circleId, identity, contentKey } = await makeCircle();
    const encryptedFor = (name: string) =>
      buildAndEncryptLogEntry(
        'member_added',
        { identityPublicKey: bytesToHex(generateIdentity().publicKey), encPublicKey: 'cc', name, role: 'member' },
        identity,
        contentKey
      );
    (fetchEntries as jest.Mock)
      .mockResolvedValueOnce({ entries: [entry(1, encryptedFor('First'))], currentEpoch: 2 })
      .mockResolvedValueOnce({ entries: [entry(2, encryptedFor('Second'))], currentEpoch: 2 });

    await pullMeta(circleId);

    expect(fetchEntries).toHaveBeenCalledTimes(2);
    // Second call resumes from the first page's last entry, not from 0.
    expect((fetchEntries as jest.Mock).mock.calls[1][2]).toBe(1);
    const members = await getCircleMembers(circleId);
    expect(members.map((member) => member.name)).toEqual(expect.arrayContaining(['First', 'Second']));
  });
});

describe('pullContent', () => {
  test('materializes a post with its photo still pending download', async () => {
    const { circleId, identity, contentKey } = await makeCircle();
    const postId = generateUUID();
    const photoHash = hashBytes(new Uint8Array([1, 2, 3]));
    const encrypted = buildAndEncryptLogEntry(
      'post',
      { postId, caption: 'Nana in the kitchen', photoHash, createdAt: 5000, keyVersion: 1 },
      identity,
      contentKey
    );
    onePage([entry(4, encrypted)]);

    await pullContent(circleId);

    const [post] = await getCircleFeed(circleId);
    expect(post).toMatchObject({ id: postId, caption: 'Nana in the kitchen', photoStatus: 'pending' });
    expect(post.photo).toBeNull();
    await expect(getCircle(circleId)).resolves.toMatchObject({ contentCursor: 4 });
  });

  test('discards a post whose author is not a known member', async () => {
    const { circleId, contentKey } = await makeCircle();
    const stranger = generateIdentity();
    const encrypted = buildAndEncryptLogEntry(
      'post',
      { postId: generateUUID(), caption: 'Not from a member', photoHash: 'aa', createdAt: 1, keyVersion: 1 },
      stranger,
      contentKey
    );
    onePage([entry(2, encrypted)]);

    await pullContent(circleId);

    expect(await getCircleFeed(circleId)).toHaveLength(0);
  });

  test('discards an entry whose signature does not verify', async () => {
    const { circleId, identity, contentKey } = await makeCircle();
    const encrypted = buildAndEncryptLogEntry(
      'post',
      { postId: generateUUID(), caption: 'Tampered', photoHash: 'aa', createdAt: 1, keyVersion: 1 },
      identity,
      contentKey
    );
    // Flip a byte inside the ciphertext body, past the 24-byte nonce.
    encrypted[30] ^= 0xff;
    onePage([entry(2, encrypted)]);

    await pullContent(circleId);

    expect(await getCircleFeed(circleId)).toHaveLength(0);
  });

  test('discards an entry of a type this build does not understand', async () => {
    const { circleId, identity, contentKey } = await makeCircle();
    const encrypted = buildAndEncryptLogEntry('quantum_post', { postId: 'x' }, identity, contentKey);
    onePage([entry(6, encrypted)]);

    await pullContent(circleId);

    expect(await getCircleFeed(circleId)).toHaveLength(0);
    await expect(getCircle(circleId)).resolves.toMatchObject({ contentCursor: 6 });
  });
});
