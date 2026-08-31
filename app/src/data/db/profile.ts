import { eq } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { deviceProfile } from '@/data/db/schema';

export type Profile = {
  name: string;
  picture: Uint8Array | null;
  createdAt: number;
  updatedAt: number;
};

/** Returns the device's profile, or null before onboarding has set one up. */
export async function getProfile(): Promise<Profile | null> {
  const rows = await db
    .select({
      name: deviceProfile.name,
      picture: deviceProfile.picture,
      createdAt: deviceProfile.createdAt,
      updatedAt: deviceProfile.updatedAt,
    })
    .from(deviceProfile)
    .where(eq(deviceProfile.id, 0));
  return rows[0] ? { ...rows[0], picture: normalizeBlob(rows[0].picture) } : null;
}

/**
 * Creates or updates the device profile. `createdAt` is only honored on the
 * very first save — it's deliberately left out of the `set` clause below,
 * so editing your name/picture later never resets when the profile was
 * originally created.
 */
export async function saveProfile(profile: Profile): Promise<void> {
  await db
    .insert(deviceProfile)
    .values({ id: 0, ...profile })
    .onConflictDoUpdate({
      target: deviceProfile.id,
      set: { name: profile.name, picture: profile.picture, updatedAt: profile.updatedAt },
    });
}
