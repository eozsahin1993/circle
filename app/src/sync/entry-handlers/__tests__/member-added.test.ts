jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleMembers, initDatabase, insertCircle, insertMember, MemberRoles } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { memberAddedHandler } from '@/sync/entry-handlers/member-added';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

/**
 * Handlers only ever see envelopes the walker has already decrypted and
 * signature-checked, so these are built literally — the signature field is
 * never re-examined here, and a fake one keeps the tests about the rules
 * rather than about crypto.
 */
function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'member_added', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

function payloadFor(identityPublicKey: string, name: string, role: 'admin' | 'member' = 'member') {
  return { identityPublicKey: identityPublicKey, encPublicKey: 'cc', name, role };
}

/** A circle with no roster at all — the state a joiner walking meta from epoch 0 starts in. */
async function emptyCircle(): Promise<string> {
  const circleId = generateUUID();
  await insertCircle({
    id: circleId,
    name: 'Family Circle',
    picture: null,
    syncId: generateUUID(),
    createdAt: Date.now(),
    leftAt: null,
    metaCursor: 0,
    contentCursor: 0,
    lastViewedAt: 0,
  });
  return circleId;
}

describe('predicate', () => {
  test('trusts the first member_added when the roster is empty', async () => {
    const circleId = await emptyCircle();
    const founder = generateIdentity();

    const trusted = await memberAddedHandler.predicate(
      circleId,
      envelope(bytesToHex(founder.publicKey), payloadFor(bytesToHex(founder.publicKey), 'Founder', 'admin'))
    );

    // Nobody exists yet who could vouch — this is how trust bootstraps.
    expect(trusted).toBe(true);
  });

  test('accepts a member_added signed by an existing admin', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const joiner = generateIdentity();

    const trusted = await memberAddedHandler.predicate(
      circleId,
      envelope(bytesToHex(founder.publicKey), payloadFor(bytesToHex(joiner.publicKey), 'Priya'))
    );

    expect(trusted).toBe(true);
  });

  test('rejects a member_added signed by someone not on the roster', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const stranger = generateIdentity();
    const joiner = generateIdentity();

    const trusted = await memberAddedHandler.predicate(
      circleId,
      envelope(bytesToHex(stranger.publicKey), payloadFor(bytesToHex(joiner.publicKey), 'Uninvited'))
    );

    expect(trusted).toBe(false);
  });

  test('rejects a member_added signed by a plain member, not an admin', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const plainMember = generateIdentity();
    await insertMember({
      circleId,
      identityPublicKey: bytesToHex(plainMember.publicKey),
      encPublicKey: 'cc',
      memberId: generateUUID(),
      role: MemberRoles.member,
      name: 'Marcus',
      picture: null,
      joinedAt: Date.now(),
      removedAt: null,
    });
    const joiner = generateIdentity();

    const trusted = await memberAddedHandler.predicate(
      circleId,
      envelope(bytesToHex(plainMember.publicKey), payloadFor(bytesToHex(joiner.publicKey), 'Their friend'))
    );

    // Adding members is an admin action; a member can't grow the circle.
    expect(trusted).toBe(false);
  });

  test.each([
    ['a non-object payload', 'not-a-payload'],
    ['a missing identityPublicKey', { encPublicKey: 'cc', name: 'X', role: 'member' }],
    ['an empty identityPublicKey', { identityPublicKey: '', encPublicKey: 'cc', name: 'X', role: 'member' }],
    ['an unrecognized role', { identityPublicKey: 'aa', encPublicKey: 'cc', name: 'X', role: 'owner' }],
    ['a non-string name', { identityPublicKey: 'aa', encPublicKey: 'cc', name: 42, role: 'member' }],
  ])('rejects %s even from a real admin', async (_label, payload) => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    const trusted = await memberAddedHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), payload));

    expect(trusted).toBe(false);
  });
});

describe('apply', () => {
  test('adds the member with the role and keys the entry declared', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const joiner = generateIdentity();
    const joinerKey = bytesToHex(joiner.publicKey);

    await memberAddedHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), payloadFor(joinerKey, 'Priya', 'admin')));

    const added = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === joinerKey);
    expect(added).toMatchObject({ name: 'Priya', role: 'admin', encPublicKey: 'cc' });
  });

  test('applying the same entry twice adds one member, not two', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const joiner = generateIdentity();
    const entry = envelope(bytesToHex(founder.publicKey), payloadFor(bytesToHex(joiner.publicKey), 'Priya'));

    await memberAddedHandler.apply(circleId, entry);
    await memberAddedHandler.apply(circleId, entry);

    expect(await getCircleMembers(circleId)).toHaveLength(2);
  });

  test('a member already on the roster keeps their existing row rather than being overwritten', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);

    // A joiner walking meta from 0 reaches the founder's own entry; the
    // local row (with its admin role) must survive that replay.
    await memberAddedHandler.apply(circleId, envelope(founderKey, payloadFor(founderKey, 'Renamed', 'member')));

    const existing = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === founderKey);
    expect(existing?.role).toBe('admin');
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const before = await getCircleMembers(circleId);

    await expect(memberAddedHandler.apply(circleId, envelope('aa', { nonsense: true }))).resolves.toBeUndefined();

    expect(await getCircleMembers(circleId)).toHaveLength(before.length);
  });

  test('persists a valid picture thumbnail', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const joiner = generateIdentity();
    const joinerKey = bytesToHex(joiner.publicKey);
    const picture = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64');

    await memberAddedHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), { ...payloadFor(joinerKey, 'Priya'), picture }));

    const added = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === joinerKey);
    expect(added?.picture).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
  });

  // picture is optional/decorative, unlike identityPublicKey/name/role — an
  // invalid one drops just the picture (see services/image.ts's
  // parsePictureThumbnail), it doesn't block admitting the member at all.
  test('an invalid picture is dropped without blocking the rest of the entry', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const joiner = generateIdentity();
    const joinerKey = bytesToHex(joiner.publicKey);
    const notAJpeg = Buffer.from([1, 2, 3]).toString('base64');

    await memberAddedHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), { ...payloadFor(joinerKey, 'Priya'), picture: notAJpeg }));

    const added = (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === joinerKey);
    expect(added?.name).toBe('Priya');
    expect(added?.picture).toBeNull();
  });
});
