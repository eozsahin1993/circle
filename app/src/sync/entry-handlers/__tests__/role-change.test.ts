jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleMembers, initDatabase, insertMember, MemberRoles } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { roleChangeHandler } from '@/sync/entry-handlers/role-change';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

/** Same "literal envelope, unchecked signature" approach as member-added.test.ts. */
function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'role_change', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
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
  test('accepts a role_change signed by an existing admin', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const target = generateIdentity();
    await addPlainMember(circleId, bytesToHex(target.publicKey));

    const trusted = await roleChangeHandler.predicate(
      circleId,
      envelope(bytesToHex(founder.publicKey), { identityPublicKey: bytesToHex(target.publicKey), role: 'admin' })
    );

    expect(trusted).toBe(true);
  });

  test('rejects a role_change signed by a plain member', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const plainMember = generateIdentity();
    await addPlainMember(circleId, bytesToHex(plainMember.publicKey));
    const target = generateIdentity();

    const trusted = await roleChangeHandler.predicate(
      circleId,
      envelope(bytesToHex(plainMember.publicKey), { identityPublicKey: bytesToHex(target.publicKey), role: 'admin' })
    );

    expect(trusted).toBe(false);
  });

  test.each([
    ['a non-object payload', 'not-a-payload'],
    ['a missing identityPublicKey', { role: 'admin' }],
    ['an unrecognized role', { identityPublicKey: 'aa', role: 'owner' }],
  ])('rejects %s even from a real admin', async (_label, payload) => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    const trusted = await roleChangeHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), payload));

    expect(trusted).toBe(false);
  });
});

describe('apply', () => {
  test('promotes a plain member to admin', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const target = generateIdentity();
    const targetKey = bytesToHex(target.publicKey);
    await addPlainMember(circleId, targetKey);

    await roleChangeHandler.apply(circleId, envelope(bytesToHex(founder.publicKey), { identityPublicKey: targetKey, role: 'admin' }));

    const member = (await getCircleMembers(circleId)).find((m) => m.identityPublicKey === targetKey);
    expect(member?.role).toBe('admin');
  });

  test('demotes an admin to a plain member', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);
    const target = generateIdentity();
    const targetKey = bytesToHex(target.publicKey);
    await addPlainMember(circleId, targetKey);
    await roleChangeHandler.apply(circleId, envelope(founderKey, { identityPublicKey: targetKey, role: 'admin' }));

    await roleChangeHandler.apply(circleId, envelope(founderKey, { identityPublicKey: targetKey, role: 'member' }));

    const member = (await getCircleMembers(circleId)).find((m) => m.identityPublicKey === targetKey);
    expect(member?.role).toBe('member');
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const before = await getCircleMembers(circleId);

    await expect(roleChangeHandler.apply(circleId, envelope('aa', { nonsense: true }))).resolves.toBeUndefined();

    expect(await getCircleMembers(circleId)).toEqual(before);
  });
});
