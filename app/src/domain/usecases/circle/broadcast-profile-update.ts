import { Buffer } from 'buffer';

import { bytesToHex } from '@noble/curves/utils.js';

import { generateUUID } from '@/services/crypto';
import { insertOutboxEntry, listCircles, OutboxStatuses, updateMemberProfile } from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { compressToThumbnail } from '@/services/image';
import { showError } from '@/services/messages';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';

/**
 * Queues one circle's `profile_update` and applies it to this device's own
 * roster row. The local write is optimistic and safe to be: this entry
 * goes down the generic append path, so there is no check that could
 * later disagree with it.
 *
 * Throws when this device holds no identity or content key for the
 * circle — nothing is queued in that case, so no later sync retries it
 * and the caller has to say so rather than fail silently.
 */
async function queueProfileUpdate(
  circleId: string,
  profile: { name: string; picture: Uint8Array | null; pictureThumbnail?: string }
): Promise<void> {
  const identity = await getCircleIdentity(circleId);
  const current = await getCurrentContentKey(circleId);
  if (!identity || !current) {
    throw new Error(`This device has no ${identity ? 'content key' : 'circle identity'} for circle ${circleId}.`);
  }

  const entry = buildAndEncryptLogEntry(
    EntryTypes.PROFILE_UPDATE,
    { name: profile.name, picture: profile.pictureThumbnail },
    identity,
    current.key
  );
  await insertOutboxEntry({
    circleId,
    entryType: EntryTypes.PROFILE_UPDATE,
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    blobEntryId: null,
    encryptedMeta: entry,
  });

  await updateMemberProfile(circleId, bytesToHex(identity.publicKey), { name: profile.name, picture: profile.picture });

  drainOutbox(circleId).catch((err) => console.error(`Failed to push profile_update for circle ${circleId}`, err));
}

/**
 * Broadcasts this device's current name/picture to every circle it's a
 * member of, one `profile_update` meta entry each — the only way a change
 * made *after* joining ever reaches another device's copy of this
 * member's roster row (`member_added` only fires once, at join time, and
 * nothing else updates it — see profile-update.ts).
 *
 * Best-effort per circle, independently: one circle being offline or
 * missing a content key doesn't block the others, and queues through the
 * same outbox every other meta write uses so a temporarily offline device
 * still gets there once connectivity returns. What it couldn't queue at
 * all is said out loud — nothing retries that, so silence would be
 * indistinguishable from having worked. Call this after saving the
 * new profile locally (see data/db/profile.ts's saveProfile) — it doesn't
 * touch the local profile row itself, only broadcasts what's already
 * there to every circle.
 */
export async function broadcastProfileUpdate(name: string, picture: Uint8Array | null): Promise<void> {
  const pictureThumbnail = picture ? Buffer.from(await compressToThumbnail(picture)).toString('base64') : undefined;

  /** Circles nothing was queued for, by name — see the message below. */
  const missed: string[] = [];

  for (const circle of await listCircles()) {
    try {
      await queueProfileUpdate(circle.id, { name, picture, pictureThumbnail });
    } catch (err) {
      console.error(`Failed to broadcast profile update to circle ${circle.id}`, err);
      missed.push(circle.name);
    }
  }

  if (missed.length > 0) {
    showError(
      missed.length === 1
        ? `Could not update your profile in ${missed[0]}`
        : 'Could not update your profile everywhere',
    );
  }
}
