jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleMembers, initDatabase, MemberRoles, recordMemberAddedLocally } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';
import { pushEnabledHandler } from '@/sync/entry-handlers/push-enabled';

const ROUTING = 'a'.repeat(64);

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
  return { type: 'push_enabled', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

async function foundedCircle() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
  return { circleId, founder };
}

async function routingOf(circleId: string, key: string) {
  return (await getCircleMembers(circleId)).find((member) => member.identityPublicKey === key)?.pushRoutingId;
}

describe('predicate', () => {
  test('accepts a member publishing their own routing id', async () => {
    const { circleId, founder } = await foundedCircle();

    await expect(
      pushEnabledHandler.predicate(circleId, envelope(founder, { pushRoutingId: ROUTING, createdAt: 1 }))
    ).resolves.toBe(true);
  });

  test('rejects one from a stranger', async () => {
    const { circleId } = await foundedCircle();
    const stranger = bytesToHex(generateIdentity().publicKey);

    await expect(
      pushEnabledHandler.predicate(circleId, envelope(stranger, { pushRoutingId: ROUTING, createdAt: 1 }))
    ).resolves.toBe(false);
  });

  test.each([
    ['a missing pushRoutingId', {}],
    ['a non-string pushRoutingId', { pushRoutingId: 42 }],
    ['a non-hex pushRoutingId', { pushRoutingId: 'z'.repeat(64) }],
    ['an empty pushRoutingId', { pushRoutingId: '' }],
    ['an over-long pushRoutingId', { pushRoutingId: 'a'.repeat(65) }],
  ])('rejects %s', async (_label, payload) => {
    const { circleId, founder } = await foundedCircle();

    await expect(pushEnabledHandler.predicate(circleId, envelope(founder, payload))).resolves.toBe(false);
  });
});

describe('apply', () => {
  test('records the routing id against the author', async () => {
    const { circleId, founder } = await foundedCircle();

    await pushEnabledHandler.apply(circleId, envelope(founder, { pushRoutingId: ROUTING, createdAt: 1 }), 1);

    expect(await routingOf(circleId, founder)).toBe(ROUTING);
  });

  test('the last one replayed wins', async () => {
    const { circleId, founder } = await foundedCircle();
    const later = 'b'.repeat(64);

    await pushEnabledHandler.apply(circleId, envelope(founder, { pushRoutingId: ROUTING, createdAt: 1 }), 1);
    await pushEnabledHandler.apply(circleId, envelope(founder, { pushRoutingId: later, createdAt: 2 }), 2);

    expect(await routingOf(circleId, founder)).toBe(later);
  });

  test('only touches the author, never another member', async () => {
    const { circleId, founder } = await foundedCircle();
    const other = bytesToHex(generateIdentity().publicKey);
    await recordMemberAddedLocally({
      circleId,
      subjectPublicKey: other,
      joinedAt: 1_000,
      profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Marcus', picture: null },
    });

    await pushEnabledHandler.apply(circleId, envelope(founder, { pushRoutingId: ROUTING, createdAt: 1 }), 1);

    expect(await routingOf(circleId, other)).toBe('');
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { circleId, founder } = await foundedCircle();

    await expect(
      pushEnabledHandler.apply(circleId, envelope(founder, { nonsense: true }), 1)
    ).resolves.toBeUndefined();
  });
});
