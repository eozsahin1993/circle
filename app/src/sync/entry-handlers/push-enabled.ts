import { setMemberPushRoutingId } from '@/data/db';
import { authoredByMember, asRecord, hexField, type EntryHandler } from '@/sync/entry-handlers/types';

/**
 * What `publishPushRoutingId` puts in a `push_enabled` entry — the author's
 * own push routing id, so other members know where to fan a notification
 * out to.
 *
 * For turning notifications on partway through a circle's life. A member
 * who already had them on when they joined carries their routing id on
 * `member_added` instead, the same way a profile does.
 *
 * There is no matching "disabled" entry: silencing is enforced by
 * unregistering at the relay, so a stale routing id in someone's roster is
 * simply a target the relay has no row for.
 */
type PushEnabledPayload = { pushRoutingId: string };

function parse(payload: unknown): PushEnabledPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const pushRoutingId = hexField(record, 'pushRoutingId', 32);
  return pushRoutingId === null ? null : { pushRoutingId };
}

export const pushEnabledHandler: EntryHandler = {
  /** Self-authored, same tier as `profile_update` — no admin involved. */
  async predicate(circleId, envelope) {
    if (!parse(envelope.payload)) return false;
    return authoredByMember(circleId, envelope);
  },

  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;
    await setMemberPushRoutingId(circleId, envelope.authorPubkey, payload.pushRoutingId);
  },
};
