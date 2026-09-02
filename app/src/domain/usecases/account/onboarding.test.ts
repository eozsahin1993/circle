import { initDatabase } from '@/data/db';
import { getProfile } from '@/data/db/profile';
import { getMasterSeed } from '@/services/keystore';
import { completeProfileSetup } from '@/domain/usecases/account/onboarding';

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
