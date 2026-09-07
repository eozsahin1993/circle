import { getCircleMembers, MemberRoles, recordRoleChanged, type MemberRole } from '@/data/db';
import { asRecord, numberField, stringField, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `change-member-role.ts` puts in a `role_change` entry. */
type RoleChangePayload = {
  identityPublicKey: string;
  role: MemberRole;
  /**
   * The acting admin's clock. Optional only for entries written before
   * this field existed — without it a device replaying from epoch 0 dates
   * the change to its own "now" and sorts it to the top of the feed, the
   * same trap `member_added`/`member_removed` already carry `createdAt`
   * to avoid.
   */
  createdAt?: number;
};

function parse(payload: unknown): RoleChangePayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const identityPublicKey = stringField(record, 'identityPublicKey');
  if (!identityPublicKey) return null;
  const { role } = record;
  if (role !== MemberRoles.admin && role !== MemberRoles.member) return null;
  return { identityPublicKey, role: role as MemberRole, createdAt: numberField(record, 'createdAt') ?? undefined };
}

export const roleChangeHandler: EntryHandler = {
  /** Same admin-at-that-point-in-meta's-order rule as `member_added`/`member_removed`. */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;

    const admins = (await getCircleMembers(circleId)).filter((member) => member.role === MemberRoles.admin);
    return admins.some((member) => member.identityPublicKey === envelope.authorPubkey);
  },

  async apply(circleId, envelope, epoch) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await recordRoleChanged({
      circleId,
      epoch,
      subjectPublicKey: payload.identityPublicKey,
      actorPublicKey: envelope.authorPubkey,
      occurredAt: payload.createdAt ?? Date.now(),
      role: payload.role,
    });
  },
};
