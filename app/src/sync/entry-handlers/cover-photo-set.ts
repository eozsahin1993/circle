import { AttachmentKinds, AttachmentStatuses, COVER_ENTRY_ID, getCircleMembers, MemberRoles, upsertAttachment } from '@/data/db';
import { asRecord, numberField, stringField, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `setCoverPhoto` puts in a `cover_photo_set` entry — the image itself is a separate blob. */
type CoverPhotoSetPayload = {
  photoHash: string;
  keyVersion: number;
};

function parse(payload: unknown): CoverPhotoSetPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const photoHash = stringField(record, 'photoHash');
  const keyVersion = numberField(record, 'keyVersion');
  if (!photoHash || keyVersion === null) return null;
  return { photoHash, keyVersion };
}

export const coverPhotoSetHandler: EntryHandler = {
  /** Admin only, same rule as every other meta entry that changes the circle itself. */
  async predicate(circleId, envelope) {
    if (!parse(envelope.payload)) return false;

    const admins = (await getCircleMembers(circleId)).filter((member) => member.role === MemberRoles.admin);
    return admins.some((member) => member.identityPublicKey === envelope.authorPubkey);
  },

  /**
   * Queues the image for the download queue rather than fetching it here
   * — the log pass does no photo work, so a slow blob can't hold up
   * roster sync (photo-queue.ts).
   *
   * An upsert, not an insert: a circle's cover always lives at the same
   * fixed `COVER_ENTRY_ID`, so replacing one overwrites the previous
   * row's hash and resets it to pending. `keyVersion` comes from the
   * entry because the blob was encrypted under whatever was current at
   * upload time, which a later rotation changes.
   */
  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await upsertAttachment({
      circleId,
      entryId: COVER_ENTRY_ID,
      kind: AttachmentKinds.CIRCLE_COVER,
      bytes: null,
      hash: payload.photoHash,
      keyVersion: payload.keyVersion,
      status: AttachmentStatuses.PENDING,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt: Date.now(),
    });
  },
};
