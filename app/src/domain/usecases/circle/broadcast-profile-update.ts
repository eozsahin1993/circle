import { Buffer } from 'buffer';

import { bytesToHex } from '@noble/curves/utils.js';

import { generateUUID } from '@/services/crypto';
import { insertOutboxEntry, listCircles, OutboxStatuses, updateMemberProfile } from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { compressToThumbnail } from '@/services/image';
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
 * still gets there once connectivity returns. Call this after saving the
 * new profile locally (see data/db/profile.ts's saveProfile) — it doesn't
 * touch the local profile row itself, only broadcasts what's already
 * there to every circle.
 */
export async function broadcastProfileUpdate(name: string, picture: Uint8Array | null): Promise<void> {
  const pictureThumbnail = picture ? Buffer.from(await compressToThumbnail(picture)).toString('base64') : undefined;

  const circles = await listCircles();
  for (const circle of circles) {
    try {
      const identity = await getCircleIdentity(circle.id);
      const current = await getCurrentContentKey(circle.id);
      if (!identity || !current) continue;

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
        encryptedMeta: entry,
      });

      // Applied locally too, so this device's own view of itself (e.g.
      // circle details) reflects the change immediately rather than only
      // once this same entry round-trips back through a future sync pass.
      await updateMemberProfile(circle.id, bytesToHex(identity.publicKey), { name, picture: picture ?? null });

      drainOutbox(circle.id).catch((err) => console.error(`Failed to push profile_update for circle ${circle.id}`, err));
    } catch (err) {
      console.error(`Failed to broadcast profile update to circle ${circle.id}`, err);
    }
  }
}
