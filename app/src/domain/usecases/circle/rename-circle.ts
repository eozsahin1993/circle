import { deriveWriteToken, generateUUID } from '@/services/crypto';
import { getCircle, updateCircleName } from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { isCircleAdmin } from '@/domain/usecases/circle/invite-to-circle';
import { ensureCircleChannel } from '@/services/notification-channels';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';
import { appendEntry } from '@/services/relay';

/**
 * Renames a circle for everyone — admin only, and the same shape as
 * `setCoverPhoto`: a `circle_renamed` meta entry, then this device's own
 * local row, so it doesn't wait on its own write coming back.
 *
 * Appended rather than queued through the outbox, again matching
 * `setCoverPhoto`. A rename is a deliberate, in-the-moment act with a
 * text field open; failing loudly beats silently queueing a name the
 * person believes has already taken.
 */
export async function renameCircle(circleId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A circle needs a name.');

  const circle = await getCircle(circleId);
  if (!circle) throw new Error('No local circle row for this id.');
  if (!(await isCircleAdmin(circleId))) throw new Error('Only an admin can rename this circle.');

  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const entry = buildAndEncryptLogEntry(
    EntryTypes.CIRCLE_RENAMED,
    { name: trimmed, createdAt: Date.now() },
    identity,
    current.key
  );
  await appendEntry(
    circle.syncId,
    'meta',
    generateUUID(),
    entry,
    current.version,
    deriveWriteToken(current.key)
  );

  await updateCircleName(circleId, trimmed);
  // A group's name updates in place, unlike a channel's sound.
  await ensureCircleChannel(circleId, trimmed);
}
