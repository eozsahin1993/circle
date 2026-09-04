import { getMemberByPublicKey, getPost, insertCommentIfAbsent } from '@/data/db';
import { asRecord, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `addComment` puts in a `comment` entry. The author rides on the envelope, not in here. */
type CommentPayload = {
  commentId: string;
  postId: string;
  body: string;
  createdAt: number;
};

function parse(payload: unknown): CommentPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const { commentId, postId, body, createdAt } = record;
  if (typeof commentId !== 'string' || !commentId) return null;
  if (typeof postId !== 'string' || !postId) return null;
  if (typeof body !== 'string') return null;
  if (typeof createdAt !== 'number') return null;
  return { commentId, postId, body, createdAt };
}

export const commentHandler: EntryHandler = {
  /**
   * Two conditions, and the second one is about robustness rather than
   * authorization.
   *
   * The author must be someone this device has seen join — the same
   * ever-member rule posts use, so a stranger can't comment even holding
   * the content key.
   *
   * The commented-on post must also already exist locally. Normally it
   * does: a comment is always appended after its post, and content is
   * replayed in epoch order. But if that post was skipped — an unknown
   * key version, a failed signature — its comments would otherwise hit
   * `post_comments`' foreign key and throw, which the walker reads as a
   * *transient* local-write failure and stops the whole pass on. Checking
   * here turns "the post never landed" into an ordinary discard that the
   * walk moves past, rather than one bad post wedging the circle.
   */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;

    if (!(await getMemberByPublicKey(circleId, envelope.authorPubkey))) return false;

    return (await getPost(payload.postId)) !== null;
  },

  async apply(_circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    await insertCommentIfAbsent({
      id: payload.commentId,
      postId: payload.postId,
      authorPublicKey: envelope.authorPubkey,
      body: payload.body,
      createdAt: payload.createdAt,
    });
  },
};
