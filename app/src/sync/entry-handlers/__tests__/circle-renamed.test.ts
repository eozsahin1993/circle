jest.mock('@/services/relay');
jest.mock('@/services/push-channels');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleSummary, initDatabase, MemberRoles, recordMemberAddedLocally } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { ensureCircleChannel } from '@/services/push-channels';
import { circleRenamedHandler } from '@/sync/entry-handlers/circle-renamed';

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
  return { type: 'circle_renamed', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

async function foundedCircle() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
  return { circleId, founder };
}

async function plainMember(circleId: string) {
  const key = bytesToHex(generateIdentity().publicKey);
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: key,
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Marcus', picture: null },
  });
  return key;
}

describe('predicate', () => {
  test('accepts a rename from an admin', async () => {
    const { circleId, founder } = await foundedCircle();

    await expect(
      circleRenamedHandler.predicate(circleId, envelope(founder, { name: 'Nana’s House', createdAt: 1 }))
    ).resolves.toBe(true);
  });

  test('rejects one from a plain member', async () => {
    const { circleId } = await foundedCircle();
    const member = await plainMember(circleId);

    await expect(
      circleRenamedHandler.predicate(circleId, envelope(member, { name: 'Nana’s House', createdAt: 1 }))
    ).resolves.toBe(false);
  });

  test.each([
    ['a missing name', { createdAt: 1 }],
    ['an empty name', { name: '', createdAt: 1 }],
    ['a non-string name', { name: 42, createdAt: 1 }],
    ['a missing createdAt', { name: 'Nana’s House' }],
  ])('rejects %s even from an admin', async (_label, payload) => {
    const { circleId, founder } = await foundedCircle();

    await expect(circleRenamedHandler.predicate(circleId, envelope(founder, payload))).resolves.toBe(false);
  });
});

describe('apply', () => {
  /** Most renames arrive here, not from this device, so the channel follows. */
  test('the Android channel is renamed with it', async () => {
    const { circleId, founder } = await foundedCircle();

    await circleRenamedHandler.apply(circleId, envelope(founder, { name: 'Nana House', createdAt: 2 }), 1);

    expect(ensureCircleChannel).toHaveBeenCalledWith(circleId, 'Nana House');
  });

  test('renames the circle', async () => {
    const { circleId, founder } = await foundedCircle();

    await circleRenamedHandler.apply(circleId, envelope(founder, { name: 'Nana’s House', createdAt: 2 }), 1);

    expect((await getCircleSummary(circleId))?.name).toBe('Nana’s House');
  });

  /**
   * Meta replays in epoch order, and that order alone decides the name —
   * no timestamps compared, so two devices can't land on different ones.
   */
  test('the last rename replayed wins, whatever its payload timestamps say', async () => {
    const { circleId, founder } = await foundedCircle();

    // Deliberately descending createdAt: only replay order should matter.
    await circleRenamedHandler.apply(circleId, envelope(founder, { name: 'Later', createdAt: 9_000 }), 1);
    await circleRenamedHandler.apply(circleId, envelope(founder, { name: 'Winner', createdAt: 2_000 }), 2);

    expect((await getCircleSummary(circleId))?.name).toBe('Winner');
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { circleId, founder } = await foundedCircle();

    await expect(
      circleRenamedHandler.apply(circleId, envelope(founder, { nonsense: true }), 1)
    ).resolves.toBeUndefined();

    expect((await getCircleSummary(circleId))?.name).toBe('Family Circle');
  });
});
