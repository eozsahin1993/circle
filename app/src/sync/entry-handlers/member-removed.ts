import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleMembers, MemberRoles, recordMemberRemoved } from '@/data/db';
import { syncAccountManifestBestEffort } from '@/domain/usecases/account/account-manifest';
import { purgeCircleLocally } from '@/domain/usecases/circle/purge-circle';
import { getCircleIdentity } from '@/services/keystore';
import { asRecord, numberField, stringField, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `remove-member.ts` puts in a `member_removed` entry. */
type MemberRemovedPayload = {
  identityPublicKey: string;
  /**
   * When the removing admin wrote this entry, on their clock — so every
   * device dates the removal the same way instead of using its own
   * receipt time. Absent on entries written before this field existed,
   * which fall back to receipt time (see `apply`).
   */
  createdAt?: number;
};

function parse(payload: unknown): MemberRemovedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const identityPublicKey = stringField(record, 'identityPublicKey');
  if (!identityPublicKey) return null;
  return { identityPublicKey, createdAt: numberField(record, 'createdAt') ?? undefined };
}

export const memberRemovedHandler: EntryHandler = {
  /**
   * Two ways a removal is legitimate: an admin removed someone, or
   * someone removed themselves. The second is how `leaveCircle`
   * announces a departure, and it can't be admin-gated — any member may
   * leave, and there's no way for them to get an admin to co-sign their
   * exit. Everyone can always speak for themselves, so accepting it
   * grants no authority over anyone else.
   *
   * Either way the subject has to be currently on the roster, because
   * `member_events` records whatever it's handed: without this, a
   * fabricated entry — or `removeMember` retried after a mid-rotation
   * failure — leaves a permanent extra line in the feed.
   *
   * The exception is this device's own identity, accepted even once
   * marked removed: `leaveCircle` marks it while the departure is still
   * queued, and an admin's removal is how this device learns to stop
   * retrying (see `finishDeparture`).
   */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;

    const members = await getCircleMembers(circleId);
    if (!members.some((member) => member.identityPublicKey === payload.identityPublicKey)) {
      const identity = await getCircleIdentity(circleId);
      if (!identity || bytesToHex(identity.publicKey) !== payload.identityPublicKey) return false;
    }
    if (payload.identityPublicKey === envelope.authorPubkey) return true;

    const admins = members.filter((member) => member.role === MemberRoles.admin);
    return admins.some((member) => member.identityPublicKey === envelope.authorPubkey);
  },

  /**
   * Records the removal and marks the target removed (see
   * `recordMemberRemoved` for why it's not a delete). If the target is
   * this device's own identity, also does `leaveCircle`'s cleanup,
   * inlined rather than imported — importing it would cycle back through
   * invite-to-circle.ts -> pull-log.ts -> here.
   */
  async apply(circleId, envelope, epoch) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await recordMemberRemoved({
      circleId,
      epoch,
      subjectPublicKey: payload.identityPublicKey,
      actorPublicKey: envelope.authorPubkey,
      occurredAt: payload.createdAt ?? Date.now(),
    });

    const identity = await getCircleIdentity(circleId);
    if (identity && bytesToHex(identity.publicKey) === payload.identityPublicKey) {
      await purgeCircleLocally(circleId);
      await syncAccountManifestBestEffort();
    }
  },
};
