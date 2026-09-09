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

  const circles = await listCircles();
  /** Circles nothing was queued for, by name — see the message below. */
  const missed: string[] = [];

  for (const circle of circles) {
    try {
      const identity = await getCircleIdentity(circle.id);
      const current = await getCurrentContentKey(circle.id);
      // Worth a line even though there's nothing to do about it: unlike a
      // failed push, nothing is queued, so no later sync retries this and
      // the circle simply never learns. Silence made that indistinguishable
      // from success.
      if (!identity || !current) {
        console.error(
          `Skipped the profile update for circle ${circle.id}: this device has no ${identity ? 'content key' : 'circle identity'} for it.`,
        );
        missed.push(circle.name);
        continue;
      }

      const entry = buildAndEncryptLogEntry(
        EntryTypes.PROFILE_UPDATE,
        { name, picture: pictureThumbnail },
        identity,
        current.key
      );
      await insertOutboxEntry({
        circleId: circle.id,
        entryType: EntryTypes.PROFILE_UPDATE,
        entryId: generateUUID(),
        status: OutboxStatuses.pending,
        epoch: null,
        blobEntryId: null,
        encryptedMeta: entry,
      });

      // Applied locally too, so this device's own view of itself (e.g.
      // circle details) reflects the change immediately rather than only
      // once this same entry round-trips back through a future sync pass.
      await updateMemberProfile(circle.id, bytesToHex(identity.publicKey), { name, picture: picture ?? null });

      drainOutbox(circle.id).catch((err) => console.error(`Failed to push profile_update for circle ${circle.id}`, err));
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
