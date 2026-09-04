jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleMembers, insertMember, MemberRoles, initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { profileUpdateHandler } from '@/sync/entry-handlers/profile-update';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

/** Handlers only ever see envelopes the walker already decrypted/verified — see member-added.test.ts's own doc comment. */
function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'profile_update', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

/** A base64 payload that actually passes parsePictureThumbnail's JPEG-magic check — see services/image.ts. */
function validThumbnail(...extraBytes: number[]): string {
  return Buffer.from([0xff, 0xd8, 0xff, ...extraBytes]).toString('base64');
}

describe('predicate', () => {
  test('accepts an update signed by a current member', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    const trusted = await profileUpdateHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), { name: 'Renamed' }));

    expect(trusted).toBe(true);
  });

  test('rejects an update signed by someone who has never joined', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const stranger = generateIdentity();

    const trusted = await profileUpdateHandler.predicate(circleId, envelope(bytesToHex(stranger.publicKey), { name: 'Nice try' }));

    expect(trusted).toBe(false);
  });

  test.each([
    ['a non-object payload', 'not-a-payload'],
    ['a missing name', {}],
    ['a non-string name', { name: 42 }],
  ])('rejects %s even from a real member', async (_label, payload) => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    const trusted = await profileUpdateHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), payload));

    expect(trusted).toBe(false);
  });

  // picture is optional and decorative, unlike name — an invalid one
  // degrades to "no picture" (see services/image.ts's parsePictureThumbnail)
  // rather than invalidating an otherwise-legitimate update.
  test.each([
    ['a non-string picture', { name: 'X', picture: 42 }],
    ['a picture that is not actually a JPEG', { name: 'X', picture: Buffer.from([1, 2, 3]).toString('base64') }],
  ])('accepts %s, just without the picture', async (_label, payload) => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    const trusted = await profileUpdateHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), payload));

    expect(trusted).toBe(true);
  });
});

describe('apply', () => {
  test("updates the author's own name and picture", async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);

    await profileUpdateHandler.apply(circleId, envelope(founderKey, { name: 'New Name', picture: validThumbnail(9, 9, 9) }));

    const updated = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === founderKey);
    expect(updated?.name).toBe('New Name');
    expect(updated?.picture).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9]));
  });

  test('omitting picture clears it rather than leaving the old one', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);

    await profileUpdateHandler.apply(circleId, envelope(founderKey, { name: 'Founder', picture: validThumbnail(1) }));
    await profileUpdateHandler.apply(circleId, envelope(founderKey, { name: 'Founder' }));

    const updated = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === founderKey);
    expect(updated?.picture).toBeNull();
  });

  test('an invalid picture clears it too, rather than being silently kept', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);

    await profileUpdateHandler.apply(circleId, envelope(founderKey, { name: 'Founder', picture: validThumbnail(1) }));
    await profileUpdateHandler.apply(circleId, envelope(founderKey, { name: 'Founder', picture: 'not-a-real-thumbnail' }));

    const updated = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === founderKey);
    expect(updated?.name).toBe('Founder');
    expect(updated?.picture).toBeNull();
  });

  test("never touches a different member's row", async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const other = generateIdentity();
    await insertMember({
      circleId,
      identityPublicKey: bytesToHex(other.publicKey),
      encPublicKey: 'cc',
      memberId: generateUUID(),
      role: MemberRoles.member,
      name: 'Untouched',
      picture: null,
      joinedAt: Date.now(),
    });
    const founder = (await getCircleIdentity(circleId))!;

    await profileUpdateHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), { name: 'Founder Renamed' }));

    const untouched = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === bytesToHex(other.publicKey));
    expect(untouched?.name).toBe('Untouched');
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);
    const before = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === founderKey);

    await expect(profileUpdateHandler.apply(circleId, envelope(founderKey, { nonsense: true }))).resolves.toBeUndefined();

    const after = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === founderKey);
    expect(after).toEqual(before);
  });
});
