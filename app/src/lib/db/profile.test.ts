import { initDatabase } from '@/lib/db';
import { getProfile, saveProfile } from '@/lib/db/profile';

beforeAll(() => initDatabase());

describe('device profile', () => {
  test('getProfile returns null before any profile is saved', async () => {
    await expect(getProfile()).resolves.toBeNull();
  });

  test('saveProfile then getProfile returns the same profile', async () => {
    const profile = { name: 'Emre', picture: null, createdAt: 1000, updatedAt: 1000 };
    await saveProfile(profile);

    await expect(getProfile()).resolves.toEqual(profile);
  });

  test('saving again updates name/picture/updatedAt but preserves the original createdAt', async () => {
    await saveProfile({ name: 'Emre', picture: null, createdAt: 1000, updatedAt: 1000 });

    const picture = new Uint8Array([1, 2, 3]);
    await saveProfile({ name: 'New Name', picture, createdAt: 9999, updatedAt: 2000 });

    await expect(getProfile()).resolves.toEqual({
      name: 'New Name',
      picture,
      createdAt: 1000,
      updatedAt: 2000,
    });
  });
});
