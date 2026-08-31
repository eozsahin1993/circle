import { initDatabase } from '@/lib/db';
import { getProfile } from '@/lib/db/profile';
import { getMasterSeed } from '@/lib/keystore';
import { completeProfileSetup } from '@/lib/onboarding';

beforeAll(() => initDatabase());

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
});
