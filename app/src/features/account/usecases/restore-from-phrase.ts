import { Buffer } from 'buffer';

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { getCircleBySyncId, getProfile, insertCircle, listCircles, saveProfile } from '@/data/db';
import { fetchAccountManifest, type RecoverableCircle } from '@/features/account/usecases/account-manifest';
import { defaultCircleMask } from '@/features/push-notifications/usecases/push-preferences';
import { deriveCircleIdentity, generateUUID, seedPhraseToEntropy } from '@/core/crypto';
import { ensureCircleNotificationChannel } from '@/features/push-notifications/services/channels';
import { getMasterSeed, saveCircleIdentity, saveCircleKeyMap, saveMasterSeed } from '@/core/services/keystore';
import { syncCircle } from '@/core/sync/sync-circles';

export type RestoreResult = {
  /** How many circles came back. Null when the relay couldn't be reached, which doesn't fail the restore. */
  circleCount: number | null;
  /** The name this account last recorded, for greeting someone by it. Null if the manifest had none. */
  name: string | null;
};

/**
 * Adopts the seed behind a recovery phrase, then rebuilds every circle its
 * manifest knows about.
 *
 * Identities come back by derivation, but content keys can't: they're random
 * and unreadable from the log itself, so the manifest is the only place a
 * phrase can reach them. Everything below the circle row is left to ordinary
 * sync — a row at cursor 0 replays its whole history.
 */
export async function restoreFromPhrase(phrase: string): Promise<RestoreResult> {
  // Throws on a bad word or checksum, before anything is written.
  const seed = seedPhraseToEntropy(normalize(phrase));
  await assertSafeToAdopt(seed);
  await saveMasterSeed(seed);

  let manifest;
  try {
    manifest = await fetchAccountManifest();
  } catch (err) {
    // Offline, or a manifest under a different seed. Neither undoes a valid
    // phrase, so the restore stands and the circles come back on a retry.
    console.error('Restored the seed but could not read the account manifest', err);
    return { circleCount: null, name: null };
  }

  // Skipped when local is newer, which a re-run after a partial restore can
  // hit: the manifest's copy would otherwise undo an edit made since.
  const local = await getProfile();
  if (manifest.profile && !(local && local.updatedAt >= manifest.profile.updatedAt)) {
    await saveProfile({
      name: manifest.profile.name,
      picture: manifest.profile.picture ? new Uint8Array(Buffer.from(manifest.profile.picture, 'base64')) : null,
      createdAt: local?.createdAt ?? Date.now(),
      // Carried over, not stamped now: claiming it as newer would overwrite
      // a rename made on a device that's still running.
      updatedAt: manifest.profile.updatedAt,
    });
  }

  const circles = (manifest.circles ?? []).filter(
    (circle): circle is RecoverableCircle => circle.leftAt === undefined,
  );
  for (const circle of circles) {
    try {
      await restoreCircle(seed, circle);
    } catch (err) {
      // One bad entry mustn't cost the others; re-running picks it up.
      console.error(`Failed to restore circle ${circle.syncId}`, err);
    }
  }

  return { circleCount: circles.length, name: manifest.profile?.name ?? null };
}

/**
 * Rebuilds one circle far enough for sync to take over. No `circleMembers`
 * row: the roster is a projection of meta, and replay writes it.
 */
async function restoreCircle(seed: Uint8Array, circle: RecoverableCircle): Promise<void> {
  // `syncId` has no unique index and `insertCircle` is a plain insert, so a
  // second row would quietly replay into a parallel set of rows.
  if (await getCircleBySyncId(circle.syncId)) return;

  const keyMap = Object.fromEntries(
    Object.entries(circle.keyMap).map(([version, key]) => [Number(version), hexToBytes(key)]),
  );
  await saveCircleKeyMap(circle.circleId, keyMap);

  const identity = deriveCircleIdentity(seed, circle.circleId);
  await saveCircleIdentity(circle.circleId, { ...identity, memberId: generateUUID() });

  const now = Date.now();
  await insertCircle({
    id: circle.circleId,
    // Replaced by the first meta pass, which carries the real name and cover.
    name: '',
    picture: null,
    syncId: circle.syncId,
    pushCategoryMask: await defaultCircleMask(),
    createdAt: now,
    leftAt: null,
    metaCursor: 0,
    contentCursor: 0,
    lastViewedAt: now,
  });

  await ensureCircleNotificationChannel(circle.circleId, '');

  // The scheduler would reach this on its next pass; this fills the feed
  // while someone is still looking at the restore screen.
  syncCircle(circle.circleId).catch((err) => console.error('Failed to sync a restored circle', err));
}

/**
 * Refuses only what actually loses data: a *different* seed on a phone whose
 * circles are keyed to the current one. A matching seed passes, which is what
 * lets a restore that failed partway be run again.
 */
async function assertSafeToAdopt(seed: Uint8Array): Promise<void> {
  const existing = await getMasterSeed();
  if (!existing || bytesToHex(existing) === bytesToHex(seed)) return;
  if ((await listCircles()).length > 0) {
    throw new Error('This phone is already in a circle. Restoring would lose it.');
  }
}

/** BIP39 wants single-spaced lowercase; keyboards supply neither reliably. */
function normalize(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}
