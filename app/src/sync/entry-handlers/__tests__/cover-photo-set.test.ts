jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  AttachmentKinds,
  AttachmentStatuses,
  COVER_ENTRY_ID,
  getAttachment,
  getCircle,
  initDatabase,
  MemberRoles,
  recordMemberAddedLocally,
} from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { encrypt, generateIdentity, generateUUID, hashBytes } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle, getBlob } from '@/services/relay';
import { coverPhotoSetHandler } from '@/sync/entry-handlers/cover-photo-set';
import { drainPhotoQueue } from '@/sync/photo-queue';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'cover_photo_set', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

async function foundedCircle() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  return { circleId, founder, founderKey: bytesToHex(founder.publicKey) };
}

describe('predicate', () => {
  test('accepts an entry from an admin', async () => {
    const { circleId, founderKey } = await foundedCircle();

    await expect(
      coverPhotoSetHandler.predicate(circleId, envelope(founderKey, { photoHash: 'h', keyVersion: 1 }))
    ).resolves.toBe(true);
  });

  test('rejects one from a plain member', async () => {
    const { circleId } = await foundedCircle();
    const member = bytesToHex(generateIdentity().publicKey);
    await recordMemberAddedLocally({
      circleId,
      subjectPublicKey: member,
      joinedAt: 1_000,
      profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Marcus', picture: null },
    });

    await expect(
      coverPhotoSetHandler.predicate(circleId, envelope(member, { photoHash: 'h', keyVersion: 1 }))
    ).resolves.toBe(false);
  });

  test.each([
    ['a missing photoHash', { keyVersion: 1 }],
    ['a missing keyVersion', { photoHash: 'h' }],
    ['a non-object payload', 'nope'],
  ])('rejects %s even from an admin', async (_label, payload) => {
    const { circleId, founderKey } = await foundedCircle();

    await expect(coverPhotoSetHandler.predicate(circleId, envelope(founderKey, payload))).resolves.toBe(false);
  });
});

describe('apply', () => {
  test('queues the cover for the download queue rather than fetching it', async () => {
    const { circleId, founderKey } = await foundedCircle();

    await coverPhotoSetHandler.apply(circleId, envelope(founderKey, { photoHash: 'abc', keyVersion: 1 }), 2);

    expect(await getAttachment(circleId, COVER_ENTRY_ID)).toMatchObject({
      kind: AttachmentKinds.CIRCLE_COVER,
      hash: 'abc',
      keyVersion: 1,
      status: AttachmentStatuses.PENDING,
    });
    // The log pass must never sit behind a blob download.
    expect(getBlob).not.toHaveBeenCalled();
  });

  /** A cover always lives at the same fixed entryId, so the second one has to overwrite the first. */
  test('replacing a cover supersedes the previous one instead of being dropped', async () => {
    const { circleId, founderKey } = await foundedCircle();

    await coverPhotoSetHandler.apply(circleId, envelope(founderKey, { photoHash: 'first', keyVersion: 1 }), 2);
    await coverPhotoSetHandler.apply(circleId, envelope(founderKey, { photoHash: 'second', keyVersion: 2 }), 3);

    expect(await getAttachment(circleId, COVER_ENTRY_ID)).toMatchObject({
      hash: 'second',
      keyVersion: 2,
      status: AttachmentStatuses.PENDING,
    });
  });

  test('the queue lands the bytes on the circle row, not in the photo cache', async () => {
    const { circleId, founderKey } = await foundedCircle();
    const cover = new Uint8Array([7, 7, 7]);
    const key = (await getCurrentContentKey(circleId))!.key;
    await coverPhotoSetHandler.apply(circleId, envelope(founderKey, { photoHash: hashBytes(cover), keyVersion: 1 }), 2);
    (getBlob as jest.Mock).mockResolvedValue(encrypt(cover, key));

    await drainPhotoQueue();

    expect((await getCircle(circleId))?.picture).toEqual(cover);
  });
});
