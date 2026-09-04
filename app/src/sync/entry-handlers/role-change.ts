import { getCircleMembers, MemberRoles, updateMemberRole, type MemberRole } from '@/data/db';
import { asRecord, stringField, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `change-member-role.ts` puts in a `role_change` entry. */
type RoleChangePayload = {
  identityPublicKey: string;
  role: MemberRole;
};

function parse(payload: unknown): RoleChangePayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const identityPublicKey = stringField(record, 'identityPublicKey');
  if (!identityPublicKey) return null;
  const { role } = record;
  if (role !== MemberRoles.admin && role !== MemberRoles.member) return null;
  return { identityPublicKey, role: role as MemberRole };
}

export const roleChangeHandler: EntryHandler = {
  /** Same admin-at-that-point-in-meta's-order rule as `member_added`/`member_removed`. */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;

    const admins = (await getCircleMembers(circleId)).filter((member) => member.role === MemberRoles.admin);
    return admins.some((member) => member.identityPublicKey === envelope.authorPubkey);
  },

  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await updateMemberRole(circleId, payload.identityPublicKey, payload.role);
  },
};
