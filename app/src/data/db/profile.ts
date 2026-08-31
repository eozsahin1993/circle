import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';

export type Profile = {
  name: string;
  picture: Uint8Array | null;
  createdAt: number;
  updatedAt: number;
};

const PROFILE_COLUMNS = `name, picture, created_at AS createdAt, updated_at AS updatedAt`;

/** Returns the device's profile, or null before onboarding has set one up. */
export async function getProfile(): Promise<Profile | null> {
  const profile = await db.getFirstAsync<Profile>(`SELECT ${PROFILE_COLUMNS} FROM device_profile WHERE id = 0`);
  return profile ? { ...profile, picture: normalizeBlob(profile.picture) } : null;
}

/**
 * Creates or updates the device profile. `createdAt` is only honored on the
 * very first save — it's deliberately left out of the UPDATE clause below,
 * so editing your name/picture later never resets when the profile was
 * originally created.
 */
export async function saveProfile(profile: Profile): Promise<void> {
  await db.runAsync(
    `INSERT INTO device_profile (id, name, picture, created_at, updated_at)
     VALUES (0, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       picture = excluded.picture,
       updated_at = excluded.updated_at`,
    profile.name,
    profile.picture,
    profile.createdAt,
    profile.updatedAt,
  );
}
