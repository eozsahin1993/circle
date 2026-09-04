import { getAllCircles } from '@/data/db';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { timed } from '@/services/timing';
import { pullContent, pullMeta } from '@/sync/pull-log';

/**
 * One circle's log pass: catch up on meta, push whatever is queued, then
 * catch up on content. Deliberately contains no photo work — photos are
 * bulk, and this is what a screen or a pull-to-refresh waits on.
 *
 * Meta is pulled *before* pushing because pushing depends on it: the
 * write token and key version come from the current content key, so a
 * device that hasn't seen a rotation would have its append bounced. That
 * turns the design's "sync, retry" case from the common path into a rare
 * one. Content is pulled after the push instead of before, so a large
 * backlog of someone else's posts doesn't delay your own going out.
 */
export async function syncCircle(circleId: string): Promise<void> {
  await timed('sync.meta', () => pullMeta(circleId));
  await timed('sync.push', () => drainOutbox(circleId));
  await timed('sync.content', () => pullContent(circleId));
}

/**
 * Log pass for every circle this device is still in, one at a time — at
 * family-circle scale there are few enough that sequential is simpler
 * than any concurrency limit. A failure is contained to its own circle so
 * one broken circle can't stop the rest syncing.
 */
export async function syncAllCircles(): Promise<void> {
  for (const circle of await getAllCircles()) {
    try {
      await syncCircle(circle.id);
    } catch (err) {
      console.error(`Failed to sync circle ${circle.id}`, err);
    }
  }
}
