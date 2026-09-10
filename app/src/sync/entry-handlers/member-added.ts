import { getCircleMembers, MemberRoles, recordMemberAdded, type MemberRole } from '@/data/db';
import { generateUUID } from '@/services/crypto';
import { parsePictureThumbnail } from '@/services/image';
import { asRecord, numberField, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `createCircle` and `invite-to-circle.ts`'s `approveJoinRequest` put in a `member_added` entry. */
type MemberAddedPayload = {
  identityPublicKey: string;
  encPublicKey: string;
  name: string;
  role: MemberRole;
  /**
   * Already validated and decoded — see `parsePictureThumbnail`. Whatever
   * the wire format was (base64 avatar-sized JPEG, per
   * `compressToThumbnail`), a malformed, oversized, or non-JPEG value
   * degrades to `undefined` here rather than rejecting the whole entry:
   * name/role are essential to admitting this member at all, a picture
   * isn't. Not updated by anything after this entry; a later picture
   * change has no propagation mechanism yet.
   */
  picture?: Uint8Array;
  /**
   * When the author wrote this entry, on their clock — the same basis
   * `posts.createdAt` uses, so joins interleave with posts consistently
   * in the feed. Absent on entries written before this field existed,
   * which fall back to receipt time (see `apply`).
   */
  createdAt?: number;
  /** Empty when this member had notifications off at join time. */
  pushRoutingId: string;
};

function parse(payload: unknown): MemberAddedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const { identityPublicKey, encPublicKey, name, role } = record;
  if (typeof identityPublicKey !== 'string' || !identityPublicKey) return null;
  if (typeof encPublicKey !== 'string') return null;
  if (typeof name !== 'string') return null;
  if (role !== MemberRoles.admin && role !== MemberRoles.member) return null;
  return {
    identityPublicKey,
    encPublicKey,
    name,
    role: role as MemberRole,
    picture: parsePictureThumbnail(record.picture) ?? undefined,
    createdAt: numberField(record, 'createdAt') ?? undefined,
    // Tolerant, never rejecting: entries written before push existed have
    // no pushRoutingId, and a check here would drop them forever on replay
    // (server/SYNC_DESIGN.md invariant 1). Absent means "not reachable
    // yet", which a later push_enabled entry fills in.
    pushRoutingId: typeof record.pushRoutingId === 'string' && /^[0-9a-f]{64}$/.test(record.pushRoutingId) ? record.pushRoutingId : '',
  };
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
    const admins = members.filter((member) => member.role === MemberRoles.admin);

    // "Nobody has vouched yet" means no *admin* exists yet — not that the
    // table is empty. A joiner replaying from epoch 0 already holds one
    // row: its own, written by completeJoin so it can see itself before
    // the first sync. Testing for an empty table would therefore never
    // fire for the one case this exemption exists to serve, and the
    // founder's entry would be rejected for lacking a voucher that only
    // that same entry can install.
    if (admins.length === 0) return true;

    return admins.some((member) => member.identityPublicKey === envelope.authorPubkey);
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
  async apply(circleId, envelope, epoch) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    // The entry's own timestamp wins over this device's clock wherever it
    // exists: the joiner's device already wrote this row in `completeJoin`
    // stamped at the moment it noticed the approval, which can be long
    // after the approval itself, and a device replaying from epoch 0 has
    // no business dating a years-old join to today. `recordMemberAdded`
    // writes it to both the event row and the roster, so the two agree.
    await recordMemberAdded({
      circleId,
      epoch,
      subjectPublicKey: payload.identityPublicKey,
      actorPublicKey: envelope.authorPubkey,
      occurredAt: payload.createdAt ?? Date.now(),
      profile: {
        encPublicKey: payload.encPublicKey,
        memberId: generateUUID(),
        role: payload.role,
        name: payload.name,
        picture: payload.picture ?? null,
        pushRoutingId: payload.pushRoutingId,
      },
    });
  },
};
