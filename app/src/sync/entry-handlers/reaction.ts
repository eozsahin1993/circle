import { addReaction, removeReaction } from '@/data/db';
import {
  asRecord,
  authoredByMember,
  numberField,
  stringField,
  type EntryHandler,
} from '@/sync/entry-handlers/types';

/**
 * What `toggleReaction` puts in a `reaction` entry. `reacted` carries the
 * direction because the log is append-only — un-reacting can't remove the
 * earlier entry, only supersede it.
 */
type ReactionPayload = {
  postId: string;
  emoji: string;
  reacted: boolean;
  createdAt: number;
};

function parse(payload: unknown): ReactionPayload | null {
  const record = asRecord(payload);
  if (!record) return null;

  const postId = stringField(record, 'postId');
  const emoji = stringField(record, 'emoji');
  const createdAt = numberField(record, 'createdAt');
  if (postId === null || emoji === null || createdAt === null) return null;
  if (typeof record.reacted !== 'boolean') return null;

  return { postId, emoji, reacted: record.reacted, createdAt };
}

export const reactionHandler: EntryHandler = {
  async predicate(circleId, envelope) {
    if (!parse(envelope.payload)) return false;

    return authoredByMember(circleId, envelope);
  },

  /**
   * Replaying content in epoch order means the last toggle a member made
   * is the one that sticks, on every device, without any of them needing
   * to compare timestamps. Removing something already absent is a no-op,
   * and adding is idempotent through the (post, author, emoji) key — so a
   * replayed entry lands the same way twice.
   *
   * A reaction on a post this device skipped hits the foreign key and is
   * classified as a permanent write failure by the walker, same as a
   * comment in that position.
   */
  async apply(_circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    if (payload.reacted) {
      await addReaction({
        postId: payload.postId,
        authorPublicKey: envelope.authorPubkey,
        emoji: payload.emoji,
        createdAt: payload.createdAt,
      });
    } else {
      await removeReaction(payload.postId, envelope.authorPubkey, payload.emoji);
    }
  },
};
