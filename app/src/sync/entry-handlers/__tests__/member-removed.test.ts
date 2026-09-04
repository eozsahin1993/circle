jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircle, getCircleMembers, initDatabase, insertMember, MemberRoles } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { syncAccountManifestBestEffort } from '@/domain/usecases/account/account-manifest';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { memberRemovedHandler } from '@/sync/entry-handlers/member-removed';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (syncAccountManifestBestEffort as jest.Mock).mockResolvedValue(undefined);
});

/** Same "literal envelope, unchecked signature" approach as member-added.test.ts. */
function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'member_removed', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

async function addPlainMember(circleId: string, identityPublicKey: string) {
  await insertMember({
    circleId,
    identityPublicKey,
    encPublicKey: 'cc',
    memberId: generateUUID(),
    role: MemberRoles.member,
    name: 'Marcus',
    picture: null,
    joinedAt: Date.now(),
    removedAt: null,
  });
}

describe('predicate', () => {
  test('accepts a member_removed signed by an existing admin', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const target = generateIdentity();
    await addPlainMember(circleId, bytesToHex(target.publicKey));

    const trusted = await memberRemovedHandler.predicate(
      circleId,
      envelope(bytesToHex(founder.publicKey), { identityPublicKey: bytesToHex(target.publicKey) })
    );

    expect(trusted).toBe(true);
  });

  test('rejects a member_removed signed by a plain member', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const plainMember = generateIdentity();
    await addPlainMember(circleId, bytesToHex(plainMember.publicKey));
    const target = generateIdentity();

    const trusted = await memberRemovedHandler.predicate(
      circleId,
      envelope(bytesToHex(plainMember.publicKey), { identityPublicKey: bytesToHex(target.publicKey) })
    );

    expect(trusted).toBe(false);
  });

  test.each([
    ['a non-object payload', 'not-a-payload'],
    ['a missing identityPublicKey', {}],
    ['an empty identityPublicKey', { identityPublicKey: '' }],
  ])('rejects %s even from a real admin', async (_label, payload) => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    const trusted = await memberRemovedHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), payload));

    expect(trusted).toBe(false);
  });
});

describe('apply', () => {
  test('marks the target removed and excludes them from the roster', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const target = generateIdentity();
    const targetKey = bytesToHex(target.publicKey);
    await addPlainMember(circleId, targetKey);

    await memberRemovedHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), { identityPublicKey: targetKey }));

    expect((await getCircleMembers(circleId)).find((m) => m.identityPublicKey === targetKey)).toBeUndefined();
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const before = await getCircleMembers(circleId);

    await expect(memberRemovedHandler.apply(circleId, envelope('aa', { nonsense: true }))).resolves.toBeUndefined();

    expect(await getCircleMembers(circleId)).toEqual(before);
  });

  test('removing someone else leaves this device fully in the circle', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const target = generateIdentity();
    const targetKey = bytesToHex(target.publicKey);
    await addPlainMember(circleId, targetKey);
    // createCircle itself calls syncAccountManifestBestEffort — clear that
    // unrelated call so the assertion below is about this apply() only.
    jest.clearAllMocks();

    await memberRemovedHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), { identityPublicKey: targetKey }));

    expect((await getCircle(circleId))?.leftAt).toBeNull();
    expect(await getCircleIdentity(circleId)).not.toBeNull();
    expect(syncAccountManifestBestEffort).not.toHaveBeenCalled();
  });

  /**
   * The case this handler exists to cover: a device syncing an entry that
   * names *itself* as the removed identity must clean up locally exactly
   * like leaving does — see the handler's doc comment on why this is
   * inlined rather than calling `leaveCircle` directly (import cycle).
   */
  test('being the removed identity cleans this device up like leaving', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);
    const remover = generateIdentity();
    await addPlainMember(circleId, bytesToHex(remover.publicKey));
    // Only an admin can author a member_removed per the predicate, but
    // apply() never re-checks that — same "handlers trust the walker"
    // assumption member-added.test.ts's apply tests make.
    // createCircle itself calls syncAccountManifestBestEffort — clear that
    // unrelated call so the count below is about this apply() only.
    jest.clearAllMocks();

    await memberRemovedHandler.apply(circleId, envelope(bytesToHex(remover.publicKey), { identityPublicKey: founderKey }));

    expect((await getCircle(circleId))?.leftAt).not.toBeNull();
    expect(await getCircleIdentity(circleId)).toBeNull();
    expect(syncAccountManifestBestEffort).toHaveBeenCalledTimes(1);
  });
});
