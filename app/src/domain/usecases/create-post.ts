import { encryptJSON, generateUUID } from '@/services/crypto';
import { getCircleSecret } from '@/services/keystore';
import { insertPostAndEnqueue, OutboxStatuses } from '@/data/db';

export type CreatePostInput = {
  circleId: string;
  caption: string;
  photo: Uint8Array;
};

/**
 * Creates a post and queues it for sync in one local, offline-safe step.
 * Actually pushing the queued entry to the relay is a separate concern
 * (the outbox drain, triggered independently) — this always succeeds
 * without network access. The outbox row's encryptedMeta is built and
 * encrypted right here, once — see the comment on `encryptedMeta` in
 * schema.ts for why the drain step must never re-derive it later.
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
}
