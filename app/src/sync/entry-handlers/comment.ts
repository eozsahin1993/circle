import { insertCommentIfAbsent } from '@/data/db';
import { asRecord, authoredByMember, type EntryHandler } from '@/sync/entry-handlers/types';

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
   * The author must be someone this device has seen join — the same
   * ever-member rule posts use, so a stranger can't comment even holding
   * the content key.
   *
   * Deliberately does *not* check that the commented-on post exists.
   * Normally it does — a comment is appended after its post and content
   * replays in epoch order — but if that post was skipped, the insert
   * hits `post_comments`' foreign key. The walker classifies that as a
   * permanent write failure and moves past it, so the case is handled
   * without every handler having to pre-verify its own dependencies.
   */
  async predicate(circleId, envelope) {
    if (!parse(envelope.payload)) return false;

    return authoredByMember(circleId, envelope);
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
