import { encryptJSON, generateUUID } from '@/services/crypto';
import { getCircleSecret } from '@/services/keystore';
import { insertPostAndEnqueue, OutboxStatuses } from '@/data/db';
import { drainOutbox } from '@/domain/usecases/sync-circle';

export type CreatePostInput = {
  circleId: string;
  caption: string;
  photo: Uint8Array;
};

/**
 * Creates a post and queues it for sync in one local, offline-safe step
 * that always succeeds without network access — the outbox row's
 * encryptedMeta is built and encrypted right here, once (see the comment
 * on `encryptedMeta` in schema.ts for why the drain step must never
 * re-derive it later). Triggers a drain afterward, but doesn't wait on
 * or fail because of it: a stuck or failed push must never make posting
 * itself feel broken, since the whole point of the outbox is that they're
 * independent. The drain is also naturally retried the next time
 * anything calls it (app resume, another post, pull-to-refresh, ...), so
 * a failure here isn't a lost opportunity, just a deferred one.
 */
export async function createPost(input: CreatePostInput): Promise<void> {
  const secret = await getCircleSecret(input.circleId);
  if (!secret) throw new Error('No circle secret on this device.');

  const postId = generateUUID();
  const createdAt = Date.now();
  const encryptedMeta = encryptJSON({ postId, entryType: 'post', caption: input.caption, createdAt }, secret);

  await insertPostAndEnqueue(
    {
      id: postId,
      circleId: input.circleId,
      caption: input.caption,
      photo: input.photo,
      createdAt,
    },
    {
      circleId: input.circleId,
      entryType: 'post',
      localId: postId,
      status: OutboxStatuses.pending,
      epoch: null,
      encryptedMeta,
    }
  );

  drainOutbox(input.circleId).catch((err) => console.error('Failed to drain outbox', err));
}
