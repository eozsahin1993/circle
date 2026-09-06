import { getAllCircles, getPendingOutboxEntries } from '@/data/db';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { fetchEpochs } from '@/services/relay';
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

/**
 * The scheduler's own periodic pass: cheaply checks every circle's current
 * epoch first, and only runs a real syncCircle for one that actually needs
 * it — either the relay has something new (its epoch is ahead of this
 * device's own cursor), or this device still has something queued to push.
 *
 * The pending-push check matters and is easy to miss: gating only on the
 * relay's epoch would silently stop retrying a locally-queued post/comment
 * that failed to push, for any circle where nobody else's content ever
 * changes again — syncCircle is what actually retries drainOutbox, so a
 * circle with something still queued locally needs a real pass even when
 * the relay has nothing new to offer. getPendingOutboxEntries is a local
 * SQLite read, not a network call, so checking it costs nothing extra.
 *
 * Unlike syncAllCircles, this is meant only for the scheduler's own
 * automatic trigger — a manual pull-to-refresh should still mean "sync
 * everything for real," never a conditional check, and keeps calling
 * syncAllCircles directly.
 */
export async function syncStaleCircles(): Promise<void> {
  const circles = await getAllCircles();
  if (circles.length === 0) return;

  const remote = await fetchEpochs(circles.map((circle) => circle.syncId));
  const remoteBySyncId = new Map(remote.map((epochs) => [epochs.syncId, epochs]));

  await Promise.all(
    circles.map(async (circle) => {
      const epochs = remoteBySyncId.get(circle.syncId);
      const hasNewContent = epochs !== undefined && (epochs.metaEpoch > circle.metaCursor || epochs.contentEpoch > circle.contentCursor);
      const hasPendingPush = (await getPendingOutboxEntries(circle.id)).length > 0;
      if (!hasNewContent && !hasPendingPush) return;

      try {
        await syncCircle(circle.id);
      } catch (err) {
        console.error(`Failed to sync circle ${circle.id}`, err);
      }
    }),
  );
}
