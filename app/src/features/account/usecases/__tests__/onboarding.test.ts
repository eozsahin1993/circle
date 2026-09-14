jest.mock('@/core/services/relay');
jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/photo/image');

import { getCircleMembers, getPendingOutboxEntries, initDatabase } from '@/data/db';
import { getProfile } from '@/data/db/profile';
import { getCircleIdentity, getMasterSeed, saveMasterSeed } from '@/core/services/keystore';
import { completeProfileSetup } from '@/features/account/usecases/onboarding';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { EntryTypes } from '@/core/sync/log-entry';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { compressToThumbnail } from '@/core/photo/image';
import { appendEntry, bootstrapCircle } from '@/core/services/relay';
import { bytesToHex } from '@noble/curves/utils.js';

// Pictures here are plain byte arrays rather than real images, so the
// thumbnailer echoes them back instead of crashing on a decode.
beforeAll(() => initDatabase());

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (compressToThumbnail as jest.Mock).mockImplementation((bytes: Uint8Array) => Promise.resolve(bytes));
});

describe('completeProfileSetup', () => {
  test('saves the profile and generates a seed on first run', async () => {
    await completeProfileSetup({ name: 'Emre', picture: null });

    await expect(getProfile()).resolves.toMatchObject({ name: 'Emre' });
    await expect(getMasterSeed()).resolves.not.toBeNull();
  });

  test('running again does not overwrite the existing seed', async () => {
    await completeProfileSetup({ name: 'Emre', picture: null });
    const firstSeed = await getMasterSeed();

    await completeProfileSetup({ name: 'Emre (edited)', picture: null });
    const secondSeed = await getMasterSeed();

    expect(secondSeed).toEqual(firstSeed);
    await expect(getProfile()).resolves.toMatchObject({ name: 'Emre (edited)' });
  });

  // Editing a profile goes through this same function, and `member_added`
  // only ever carried the name and picture a member joined with — so
  // without this entry the change reaches nobody, which is exactly what
  // shipped.
  test('tells the circles this device is in about an edited picture', async () => {
    await saveMasterSeed(new Uint8Array(16));
    const { id: circleId } = await createCircle({ name: 'Family' });

    await completeProfileSetup({ name: 'Emre', picture: new Uint8Array([7, 7, 7]) });

    const queued = await getPendingOutboxEntries(circleId);
    expect(queued.some((entry) => entry.entryType === EntryTypes.PROFILE_UPDATE)).toBe(true);

    // And on this device too: its own roster row still held the picture it
    // joined with otherwise.
    const identity = (await getCircleIdentity(circleId))!;
    const self = (await getCircleMembers(circleId)).find(
      (member) => member.identityPublicKey === bytesToHex(identity.publicKey),
    );
    expect(self?.picture).toEqual(new Uint8Array([7, 7, 7]));
  });
});
