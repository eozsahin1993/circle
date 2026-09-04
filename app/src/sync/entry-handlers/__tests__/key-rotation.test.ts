jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { initDatabase, insertMember, MemberRoles } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { deriveCircleSealingKeypair, generateContentKey, generateIdentity, generateUUID, sealToPublicKey } from '@/services/crypto';
import { getCircleIdentity, getCircleKeyMap, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { keyRotationHandler } from '@/sync/entry-handlers/key-rotation';

const MASTER_SEED = new Uint8Array(16);

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(MASTER_SEED);
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

/** Same "literal envelope, unchecked signature" approach as member-added.test.ts. */
function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'key_rotation', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

async function addPlainMember(circleId: string, identityPublicKey: string, encPublicKey: string) {
  await insertMember({
    circleId,
    identityPublicKey,
    encPublicKey,
    memberId: generateUUID(),
    role: MemberRoles.member,
    name: 'Marcus',
    picture: null,
    joinedAt: Date.now(),
    removedAt: null,
  });
}

describe('predicate', () => {
  test('accepts a key_rotation signed by an existing admin', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    const trusted = await keyRotationHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), { version: 2, wraps: {} }));

    expect(trusted).toBe(true);
  });

  test('rejects a key_rotation signed by a plain member', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const plainMember = generateIdentity();
    await addPlainMember(circleId, bytesToHex(plainMember.publicKey), 'cc');

    const trusted = await keyRotationHandler.predicate(circleId, envelope(bytesToHex(plainMember.publicKey), { version: 2, wraps: {} }));

    expect(trusted).toBe(false);
  });

  test.each([
    ['a non-object payload', 'not-a-payload'],
    ['a missing version', { wraps: {} }],
    ['a non-object wraps', { version: 2, wraps: 'nope' }],
    ['a wraps value that is not a string', { version: 2, wraps: { aa: 42 } }],
  ])('rejects %s even from a real admin', async (_label, payload) => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;

    const trusted = await keyRotationHandler.predicate(circleId, envelope(bytesToHex(founder.publicKey), payload));

    expect(trusted).toBe(false);
  });
});

describe('apply', () => {
  test("opens this device's own wrap and stores the new key version", async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);
    const sealingKeypair = deriveCircleSealingKeypair(MASTER_SEED, circleId);
    const newKey = generateContentKey();

    await keyRotationHandler.apply(
      circleId,
      envelope(founderKey, { version: 2, wraps: { [founderKey]: bytesToHex(sealToPublicKey(newKey, sealingKeypair.publicKey)) } })
    );

    const keyMap = await getCircleKeyMap(circleId);
    expect(keyMap?.[2]).toEqual(newKey);
  });

  test('a rotation with no wrap for this device is a no-op', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const stranger = generateIdentity();
    const before = await getCircleKeyMap(circleId);

    await keyRotationHandler.apply(
      circleId,
      envelope(bytesToHex(founder.publicKey), { version: 2, wraps: { [bytesToHex(stranger.publicKey)]: 'aa'.repeat(48) } })
    );

    expect(await getCircleKeyMap(circleId)).toEqual(before);
  });

  test('a wrap that fails to open (wrong key, malformed hex) is a no-op rather than a crash', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const founderKey = bytesToHex(founder.publicKey);
    const before = await getCircleKeyMap(circleId);

    await expect(
      keyRotationHandler.apply(circleId, envelope(founderKey, { version: 2, wraps: { [founderKey]: 'not-valid-hex' } }))
    ).resolves.toBeUndefined();

    expect(await getCircleKeyMap(circleId)).toEqual(before);
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const before = await getCircleKeyMap(circleId);

    await expect(keyRotationHandler.apply(circleId, envelope('aa', { nonsense: true }))).resolves.toBeUndefined();

    expect(await getCircleKeyMap(circleId)).toEqual(before);
  });
});
