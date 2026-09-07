import { setPostInAlbum } from '@/data/db';
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
   * Any member may re-file a photo, not only its author — the album is the
   * circle's shared archive. Same ever-member rule every content type
   * uses, so someone since removed doesn't have their old changes undone.
   */
  async predicate(circleId, envelope) {
    if (!parse(envelope.payload)) return false;

    return authoredByMember(circleId, envelope);
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
