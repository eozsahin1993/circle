import { getPost } from '@/data/db';
import { circleForRoutingId, decryptPushEntry, type PushData } from '@/domain/usecases/push/handle-push';

export type PushDestination =
  | { screen: 'post'; circleId: string; postId: string }
  | { screen: 'feed'; circleId: string };

/**
 * Where tapping a notification should land. The circle's feed is the
 * floor — a push that names a post this device already holds refines to
 * that post; one it can't decrypt, or whose post hasn't synced yet, still
 * opens the right circle (whose feed syncs on focus and will surface it).
 * Null only when the routing id resolves to no circle here.
 */
export async function resolvePushDestination(data: PushData): Promise<PushDestination | null> {
  if (!data.pushRoutingId) return null;

  const circle = await circleForRoutingId(data.pushRoutingId);
  if (!circle) return null;

  const envelope = await decryptPushEntry(circle.id, data);
  const postId = (envelope?.payload as { postId?: unknown } | undefined)?.postId;
  if (typeof postId === 'string' && (await getPost(postId))) {
    return { screen: 'post', circleId: circle.id, postId };
  }
  return { screen: 'feed', circleId: circle.id };
}
