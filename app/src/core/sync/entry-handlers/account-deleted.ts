import { bytesToHex } from '@noble/curves/utils.js';

import { deleteCommentsByAuthor, deletePostsByAuthor, deleteReactionsByAuthor, markCircleLeft, recordAccountDeleted } from '@/data/db';
import { recordInManifestBestEffort } from '@/features/account/usecases/account-manifest';
import { purgeCircleLocally } from '@/features/circle/usecases/purge-circle';
import { deletePhotoFile } from '@/core/photo/photo-cache';
import { getCircleIdentity } from '@/core/services/keystore/circle-keys';
import { asRecord, authoredByMember, numberField, type EntryHandler } from '@/core/sync/entry-handlers/types';

/**
 * What `deleteAccount` puts in an `account_deleted` entry. The identity
 * being deleted is `envelope.authorPubkey` — nobody erases anyone's
 * content but their own, so the payload names nothing.
 */
type AccountDeletedPayload = {
  createdAt: number;
};

function parse(payload: unknown): AccountDeletedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const createdAt = numberField(record, 'createdAt');
  if (createdAt === null) return null;

  return { createdAt };
}

export const accountDeletedHandler: EntryHandler = {
  /** Author-only, no admin branch: this isn't a moderation action. */
  async predicate(circleId, envelope) {
    if (!parse(envelope.payload)) return false;
    return authoredByMember(circleId, envelope);
  },

  /**
   * Replaces `member_removed` for this departure rather than running
   * alongside it — one entry announces it, one history row records it
   * (see `recordAccountDeleted`). Erases every local trace of what this
   * identity authored — every post it wrote (attachments and everyone's
   * comments/reactions on them included), plus its own comments and
   * reactions on other people's posts — the local half of what the
   * relay's bulk strip already did to the log; replay-safe the same way
   * post-delete.ts is.
   *
   * If the identity is this device's own — another of this account's
   * devices, still a member of this circle when the deletion happened
   * elsewhere — also does the local teardown `member-removed.ts` does
   * for its own self-removal case, inlined for the same reason: reaching
   * into `leaveCircle` from an entry handler closes a cycle through
   * pull-log → entry-handlers → back again.
   */
  async apply(circleId, envelope, epoch) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    const postIds = await deletePostsByAuthor(circleId, envelope.authorPubkey);
    for (const postId of postIds) {
      deletePhotoFile(circleId, postId);
    }
    await deleteCommentsByAuthor(circleId, envelope.authorPubkey);
    await deleteReactionsByAuthor(circleId, envelope.authorPubkey);

    await recordAccountDeleted({
      circleId,
      epoch,
      subjectPublicKey: envelope.authorPubkey,
      actorPublicKey: envelope.authorPubkey,
      occurredAt: payload.createdAt,
    });

    const identity = await getCircleIdentity(circleId);
    if (identity && bytesToHex(identity.publicKey) === envelope.authorPubkey) {
      await markCircleLeft(circleId);
      await recordInManifestBestEffort();
      await purgeCircleLocally(circleId);
    }
  },
};
