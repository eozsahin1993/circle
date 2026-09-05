import { AttachmentKinds, AttachmentStatuses, insertPost } from '@/data/db';
import { asRecord, authoredByMember, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `createPost` puts in a `post` entry — the photo itself is a separate blob. */
type PostPayload = {
  postId: string;
  caption: string;
  photoHash: string;
  createdAt: number;
  keyVersion: number;
};

function parse(payload: unknown): PostPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const { postId, caption, photoHash, createdAt, keyVersion } = record;
  if (typeof postId !== 'string' || !postId) return null;
  if (typeof caption !== 'string') return null;
  if (typeof photoHash !== 'string') return null;
  if (typeof createdAt !== 'number') return null;
  if (typeof keyVersion !== 'number') return null;
  return { postId, caption, photoHash, createdAt, keyVersion };
}

export const postHandler: EntryHandler = {
  /**
   * The author must be someone this device has seen join — checked
   * against the roster, which meta sync has already replayed in full
   * before any content entry is looked at.
   *
   * Membership here is deliberately "has ever been a member", not "is a
   * member now": removing someone doesn't retract their old posts
   * (server/SYNC_DESIGN.md's ever-member set). Today those two sets are
   * the same table, because nothing removes a roster row yet; when
   * removal lands it must mark rows rather than delete them, or this
   * check starts rejecting history.
   */
  async predicate(circleId, envelope) {
    if (!parse(envelope.payload)) return false;

    return authoredByMember(circleId, envelope);
  },

  /**
   * Writes the post and an attachment row standing in for its photo,
   * which is all the download queue needs to go find the bytes later
   * (photo-queue.ts). Never `insertPostAndEnqueue` — that would push this
   * post straight back out to the relay it just came from.
   *
   * `keyVersion` is carried from the entry rather than read from the
   * keychain's current version: the blob was encrypted under whatever was
   * current when it was uploaded, and after a rotation that is not the
   * same key.
   */
  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await insertPost(
      {
        id: payload.postId,
        circleId,
        caption: payload.caption,
        authorPublicKey: envelope.authorPubkey,
        createdAt: payload.createdAt,
        lastViewedAt: null,
      },
      {
        circleId,
        // A post photo lives at its own postId — the id drainOutbox
        // uploaded it under.
        entryId: payload.postId,
        kind: AttachmentKinds.POST_PHOTO,
        bytes: null,
        hash: payload.photoHash,
        keyVersion: payload.keyVersion,
        status: AttachmentStatuses.PENDING,
        fetchAttempts: 0,
        nextAttemptAt: null,
        createdAt: payload.createdAt,
      }
    );
  },
};
