jest.mock('@/services/relay');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/mailbox-relay');

import { bytesToHex } from '@noble/curves/utils.js';

import { initDatabase, MemberRoles, recordMemberAddedLocally, recordRoleChangedLocally } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { loadCircleDetails } from '@/domain/usecases/circle/circle-details';
import { getOrCreateInvite } from '@/domain/usecases/circle/invite-to-circle';
import { generateIdentity, generateUUID } from '@/services/crypto';
import { getCircleIdentity, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

async function addMember(circleId: string, name: string) {
  const key = bytesToHex(generateIdentity().publicKey);
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: key,
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name, picture: null },
  });
  return key;
}

test('gathers the circle, its roster, and who the reader is', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
  await addMember(circleId, 'Marcus');

  const details = await loadCircleDetails(circleId);

  expect(details.circle?.name).toBe('Family Circle');
  expect(details.members).toHaveLength(2);
  expect(details.ownPublicKey).toBe(founder);
  // The founder created the circle, so this device starts out an admin.
  expect(details.ownIsAdmin).toBe(true);
});

test('reports a plain member as not an admin', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const own = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
  await recordRoleChangedLocally({ circleId, subjectPublicKey: own, role: MemberRoles.member });

  expect((await loadCircleDetails(circleId)).ownIsAdmin).toBe(false);
});

/** The screen renders whatever comes back, so a circle it can't find has to be a shape, not a throw. */
test('returns an empty shape for a circle this device does not have', async () => {
  const details = await loadCircleDetails(generateUUID());

  expect(details).toEqual({
    circle: null,
    members: [],
    ownIsAdmin: false,
    ownPublicKey: null,
    invite: null,
    push: { silenced: false, level: 'posts', categories: [] },
  });
});

/** Read, never minted: opening the screen must not create a key, or push a preview to the relay. */
test('reads the live invite without creating one', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  expect((await loadCircleDetails(circleId)).invite).toBeNull();

  const minted = await getOrCreateInvite(circleId);

  expect((await loadCircleDetails(circleId)).invite?.code).toBe(minted.code);
});
