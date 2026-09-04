import { getCircle, insertOutboxEntry, OutboxStatuses, updateMemberRole, type MemberRole } from '@/data/db';
import { requireAdminPublicKey } from '@/domain/usecases/circle/invite-to-circle';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';

/**
 * Promotes a member to admin or demotes an admin to member — admin only,
 * and never against yourself: demoting yourself could leave a circle with
 * zero admins if you were the last one, and promoting yourself is
 * meaningless. Mirrors `remove-member.ts`'s shape end to end.
 */
export async function setMemberRole(circleId: string, identityPublicKey: string, role: MemberRole): Promise<void> {
  const ownPublicKey = await requireAdminPublicKey(circleId, "Only an admin can change a member's role.");
  if (identityPublicKey === ownPublicKey) {
    throw new Error("You can't change your own role.");
  }

  const circle = await getCircle(circleId);
  if (!circle) throw new Error('No local circle row for this id.');
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const entry = buildAndEncryptLogEntry(EntryTypes.ROLE_CHANGE, { identityPublicKey, role }, identity, current.key);
  await insertOutboxEntry({
    circleId,
    entryType: EntryTypes.ROLE_CHANGE,
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    encryptedMeta: entry,
  });

  // Applied locally too, so this device's own roster updates immediately
  // instead of only when its next sync pass walks this entry back.
  await updateMemberRole(circleId, identityPublicKey, role);

  drainOutbox(circleId).catch((err) => console.error('Failed to push role_change', err));
}
