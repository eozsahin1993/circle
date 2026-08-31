import { generateUUID } from '@/services/crypto';
import { insertPost } from '@/data/db';

export type CreatePostInput = {
  circleId: string;
  caption: string;
  photo: Uint8Array;
};

export async function createPost(input: CreatePostInput): Promise<void> {
  await insertPost({
    id: generateUUID(),
    circleId: input.circleId,
    caption: input.caption,
    photo: input.photo,
    createdAt: Date.now(),
  });
}
