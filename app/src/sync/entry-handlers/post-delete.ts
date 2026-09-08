import { deletePostLocally, getCircleMembers, getPost, MemberRoles } from '@/data/db';
import { deletePhotoFile } from '@/services/photo-cache';
import { asRecord, authoredByMember, numberField, stringField, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `deletePost` puts in a `post_delete` entry. The post's own id is all it takes — everything else about it is already on this device. */
type PostDeletePayload = {
  postId: string;
  createdAt: number;
};

function parse(payload: unknown): PostDeletePayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const postId = stringField(record, 'postId');
  const createdAt = numberField(record, 'createdAt');
  if (postId === null || createdAt === null) return null;

  return { postId, createdAt };
}

export const postDeleteHandler: EntryHandler = {
  /**
   * The photo's author or an admin, and nobody else — the same rule
   * `album-visibility.ts` enforces, and for the same reasons, including
   * why the admin is admin *now* rather than at a point in the log.
   *
   * Authorship comes from the post's own row, so a deletion naming a post
   * this device never applied passes only on the admin branch, where
   * `apply` then deletes nothing.
   */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;
    if (!(await authoredByMember(circleId, envelope))) return false;

    const post = await getPost(payload.postId);
    // Nothing to authorize: the post is already gone, or never applied
    // here, so `apply` can only be a no-op. Accepting is what keeps the
    // deleting device from rejecting its *own* entry on the way back —
    // it deleted optimistically, so the row the authorship check reads
    // is exactly the row it removed. A post this device still holds is
    // never reached by this branch, so it stays behind the rule below.
    if (!post) return true;
    if (post.authorPublicKey === envelope.authorPubkey) return true;

    const members = await getCircleMembers(circleId);
    return members.some(
      (member) => member.identityPublicKey === envelope.authorPubkey && member.role === MemberRoles.admin
    );
  },

  /**
   * Drops the row rather than tombstoning it. The log is what's permanent
   * (invariant 7: local state is a disposable projection), so a replay
   * from epoch 0 re-applies the `post` entry and then this one, in that
   * order, and lands on the same empty result — no marker needed to
   * remember the deletion.
   *
   * A comment or reaction that was already in flight lands afterwards and
   * hits `post_comments`' foreign key; the walker treats that as a
   * permanent write failure and moves past it (see comment.ts).
   */
  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await deletePostLocally(circleId, payload.postId);
    // Derived, and no longer derived from anything — the bytes are gone
    // from SQLite, so a file left here would only ever be dead weight.
    deletePhotoFile(circleId, payload.postId);
  },
};
