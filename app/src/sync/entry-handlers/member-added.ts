import { getCircleMembers, insertMemberIfAbsent, MemberRoles, type MemberRole } from '@/data/db';
import { generateUUID } from '@/services/crypto';
import { asRecord, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `createCircle` and `completeJoin` put in a `member_added` entry. */
type MemberAddedPayload = {
  identityPublicKey: string;
  encPublicKey: string;
  name: string;
  role: MemberRole;
};

function parse(payload: unknown): MemberAddedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const { identityPublicKey, encPublicKey, name, role } = record;
  if (typeof identityPublicKey !== 'string' || !identityPublicKey) return null;
  if (typeof encPublicKey !== 'string') return null;
  if (typeof name !== 'string') return null;
  if (role !== MemberRoles.admin && role !== MemberRoles.member) return null;
  return { identityPublicKey, encPublicKey, name, role: role as MemberRole };
}

export const memberAddedHandler: EntryHandler = {
  /**
   * The circle's very first `member_added` — the one that arrives while
   * this device knows of no members at all — is trusted unconditionally.
   * It has to be: it's the founder's own entry, self-signed, and there is
   * by definition nobody already on the roster who could have vouched for
   * them. That's how a joiner walking meta from epoch 0 bootstraps trust
   * from nothing.
   *
   * Every later one must be signed by someone this device already knows
   * to be an admin, which holds because meta is replayed strictly in
   * order: by the time entry N is checked, entries 1..N-1 are applied.
   * A member announcing *themselves* (which is what `completeJoin` does
   * today, rather than the approver writing it — see its doc comment)
   * therefore fails this check on other devices until that gap is closed.
   */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;

    const members = await getCircleMembers(circleId);
    if (members.length === 0) return true;

    return members.some(
      (member) => member.identityPublicKey === envelope.authorPubkey && member.role === MemberRoles.admin
    );
  },

  /**
   * `memberId` is deliberately generated here rather than read off the
   * entry: it's a purely local, self-assigned handle and is not carried
   * on the wire at all, so two devices hold different ones for the same
   * person. Nothing cross-device reads it today (comments and reactions
   * key off it locally but don't sync yet); when they do, they'll need
   * the public key instead — see server/SYNC_DESIGN.md's "One identifier,
   * four jobs".
   */
  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await insertMemberIfAbsent({
      circleId,
      identityPublicKey: payload.identityPublicKey,
      encPublicKey: payload.encPublicKey,
      memberId: generateUUID(),
      role: payload.role,
      name: payload.name,
      picture: null,
      joinedAt: Date.now(),
    });
  },
};
