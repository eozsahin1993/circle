import { getCircleMembers, MemberRoles, updateCircleName } from '@/data/db';
import { ensureCircleNotificationChannel } from '@/services/push-notification-channels';
import { asRecord, numberField, stringField, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `renameCircle` puts in a `circle_renamed` entry. */
type CircleRenamedPayload = {
  name: string;
  createdAt: number;
};

function parse(payload: unknown): CircleRenamedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const name = stringField(record, 'name');
  const createdAt = numberField(record, 'createdAt');
  if (name === null || createdAt === null) return null;
  return { name, createdAt };
}

export const circleRenamedHandler: EntryHandler = {
  /** Admin only, same rule as every other meta entry that changes the circle itself. */
  async predicate(circleId, envelope) {
    if (!parse(envelope.payload)) return false;

    const admins = (await getCircleMembers(circleId)).filter((member) => member.role === MemberRoles.admin);
    return admins.some((member) => member.identityPublicKey === envelope.authorPubkey);
  },

  /**
   * Replaying meta in epoch order leaves the last rename as the name on
   * every device, with no timestamps compared — the same convergence
   * `role_change` relies on. `createdAt` rides along for history, not for
   * deciding which rename wins.
   */
  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await updateCircleName(circleId, payload.name);
    // Most renames arrive here rather than from this device, so the
    // Android channel would otherwise keep the old name forever.
    await ensureCircleNotificationChannel(circleId, payload.name);
  },
};
