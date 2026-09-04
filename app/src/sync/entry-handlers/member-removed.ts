import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleMembers, markCircleLeft, markMemberRemoved, MemberRoles } from '@/data/db';
import { syncAccountManifestBestEffort } from '@/domain/usecases/account/account-manifest';
import { deleteCircleKeys, getCircleIdentity } from '@/services/keystore';
import { asRecord, stringField, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `remove-member.ts` puts in a `member_removed` entry. */
type MemberRemovedPayload = {
  identityPublicKey: string;
};

function parse(payload: unknown): MemberRemovedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const identityPublicKey = stringField(record, 'identityPublicKey');
  if (!identityPublicKey) return null;
  return { identityPublicKey };
}

export const memberRemovedHandler: EntryHandler = {
  /**
   * Same admin-at-that-point rule as `member_added`, no bootstrap
   * exemption needed (removal can't happen before a founder exists).
   * Doesn't check the target: removing another admin is allowed, and
   * naming someone already removed is a no-op at apply time.
   */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;

    const admins = (await getCircleMembers(circleId)).filter((member) => member.role === MemberRoles.admin);
    return admins.some((member) => member.identityPublicKey === envelope.authorPubkey);
  },

  /**
   * Marks the target removed (see `markMemberRemoved` for why not a
   * delete). If the target is this device's own identity, also does
   * `leaveCircle`'s cleanup, inlined rather than imported — importing it
   * would cycle back through invite-to-circle.ts -> pull-log.ts -> here.
   */
  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await markMemberRemoved(circleId, payload.identityPublicKey);

    const identity = await getCircleIdentity(circleId);
    if (identity && bytesToHex(identity.publicKey) === payload.identityPublicKey) {
      await markCircleLeft(circleId);
      await deleteCircleKeys(circleId);
      await syncAccountManifestBestEffort();
    }
  },
};
