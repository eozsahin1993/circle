import { getCircleMembers, getPost, MemberRoles, setPostInAlbum } from '@/data/db';
import {
  asRecord,
  authoredByMember,
  numberField,
  stringField,
  type EntryHandler,
} from '@/sync/entry-handlers/types';

/**
 * What `setAlbumVisibility` puts in an `album_visibility` entry. `inAlbum`
 * carries the direction because the log is append-only — taking a photo
 * back out can't remove the earlier entry, only supersede it.
 */
type AlbumVisibilityPayload = {
  postId: string;
  inAlbum: boolean;
  createdAt: number;
};

function parse(payload: unknown): AlbumVisibilityPayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const postId = stringField(record, 'postId');
  const createdAt = numberField(record, 'createdAt');
  if (postId === null || createdAt === null) return null;
  if (typeof record.inAlbum !== 'boolean') return null;

  return { postId, inAlbum: record.inAlbum, createdAt };
}

export const albumVisibilityHandler: EntryHandler = {
  /**
   * The photo's author or an admin, and nobody else. The author because
   * regretting their own photo shouldn't need asking permission; an admin
   * because the album is the circle's archive and wants curating. Anyone
   * else re-filing someone else's photo is what this shuts out.
   *
   * Unlike `role_change`, the admin here is admin *now* rather than at a
   * fixed point in the log: roles are meta entries and this is content, so
   * the two namespaces replay on separate epoch streams and there is no
   * shared order to read "at the time" from. Devices that have replayed
   * different amounts of meta can briefly disagree about a just-promoted
   * admin's change; they converge once meta catches up.
   *
   * Authorship is read from the post's own row, so a change naming a post
   * this device never applied can only pass on the admin branch — where it
   * reaches `apply` and updates nothing. That's deliberate: `post` is a
   * content entry too, so it has already replayed by now, and a post
   * that's still missing was one this device rejected.
   */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;
    if (!(await authoredByMember(circleId, envelope))) return false;

    const post = await getPost(payload.postId);
    if (post?.authorPublicKey === envelope.authorPubkey) return true;

    const members = await getCircleMembers(circleId);
    return members.some(
      (member) => member.identityPublicKey === envelope.authorPubkey && member.role === MemberRoles.admin
    );
  },

  /**
   * Replaying content in epoch order means the last change made wins on
   * every device, without any of them comparing timestamps — the same
   * convergence reaction.ts relies on.
   *
   * A change naming a post this device skipped updates nothing: the
   * post's row simply isn't there, and `setPostInAlbum`'s WHERE matches
   * no rows. That's a no-op rather than an error on purpose — this entry
   * is a modifier, and there's nothing to reconcile if what it modifies
   * was never applied.
   */
  async apply(_circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await setPostInAlbum(payload.postId, payload.inAlbum);
  },
};
