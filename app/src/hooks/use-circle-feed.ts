import { useCallback, useMemo, useRef, useState } from 'react';

import { useJustJoinedRows } from '@/components/feed/just-joined-row';
import { usePendingRequestRows } from '@/components/feed/pending-request-row';
import { usePostRows } from '@/components/feed/post-row';
import { usePrivacyRows } from '@/components/feed/privacy-row';
import { useRosterChangeRows } from '@/components/feed/roster-change-row';
import { buildFeedRows, type FeedRow, type FeedRows } from '@/components/feed/rows';
import { loadCircleFeed, type CircleFeed, type FeedPostView } from '@/domain/usecases/feed/circle-feed';
import { nudgePhotoQueue } from '@/sync/photo-queue';
import { syncCircle } from '@/sync/sync-circles';

export type UseCircleFeedOptions = {
  /** Whether to offer the fresh-joiner banner at all — hidden anyway once there are posts. */
  justJoined?: boolean;
  /** Stable, please: the adapter list rebuilds when it changes. */
  onPressPrivacy: () => void;
};

export type CircleFeedController = {
  /** Everything to render, in order. The screen needs nothing else about the feed. */
  rows: FeedRow[];
  circleName: string;
  memberCount: number;
  refreshing: boolean;
  /** Re-read from disk — for the focus effect. */
  reload: () => Promise<void>;
  /** Sync, then re-read — for pull-to-refresh. */
  refresh: () => Promise<void>;
};

/**
 * One circle's feed, composed from its row kinds.
 *
 * This owns only what more than one kind reads — the loaded feed — plus
 * the list saying which kinds exist and in what pinned order. Each kind's
 * own hook owns its behaviour and anything private to it: join requests
 * keep their list and in-flight flag there rather than adding three
 * fields here.
 *
 * A new kind of row is a new module and one line in `adapters`. Nothing
 * else in the feed changes, and nothing here grows a branch.
 */
export function useCircleFeed(circleId: string, options: UseCircleFeedOptions): CircleFeedController {
  const [feed, setFeed] = useState<CircleFeed | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /** The one thing a post row can't do for itself — it doesn't hold the feed. */
  const patchPost = useCallback((postId: string, change: Partial<FeedPostView>) => {
    setFeed((current) =>
      current
        ? { ...current, posts: current.posts.map((view) => (view.post.id === postId ? { ...view, ...change } : view)) }
        : current,
    );
  }, []);

  // Every kind produces `FeedRow[]` from the slice it is handed, so the
  // mapping below is a flat concatenation and nothing else.
  /**
   * Holds whatever the row kinds currently are, so `reload` can fan out to
   * them without depending on them. `sources` changes identity on every
   * load — a row kind's memo depends on the slice it was handed, and a
   * fresh `loadCircleFeed` hands it a fresh array — so a dependency here
   * would change `reload`'s identity after every load, re-fire the
   * screen's focus effect (which depends on `reload`), and load again: a
   * loop that never settles. It also lets `reload` be defined before the
   * kinds that need to call it.
   */
  const sourcesRef = useRef<FeedRows[]>([]);

  const reload = useCallback(async () => {
    if (!circleId) return;
    setFeed(await loadCircleFeed(circleId));
    // Whichever kinds own state the feed's read doesn't cover refresh it
    // themselves — this doesn't need to know which those are.
    sourcesRef.current.forEach((source) => source.reload?.());
  }, [circleId]);

  const requests = usePendingRequestRows({ circleId, onRosterChanged: reload });
  const privacy = usePrivacyRows(options.onPressPrivacy);
  const justJoined = useJustJoinedRows({ justJoined: options.justJoined ?? false, postCount: feed?.posts.length ?? 0 });
  const posts = usePostRows({
    circleId,
    patchPost,
    posts: feed?.posts ?? [],
    profile: feed?.profile ?? null,
    ownPublicKey: feed?.ownPublicKey ?? null,
    ownIsAdmin: feed?.ownIsAdmin ?? false,
  });
  const rosterChanges = useRosterChangeRows({ events: feed?.events ?? [], ownPublicKey: feed?.ownPublicKey ?? null });

  /**
   * The mapping, and the only place that knows which kinds a circle feed
   * has. Order here is the pinned order; anything carrying a time sorts by
   * it instead. Adding a kind is one hook call and one entry.
   */
  const sources: FeedRows[] = useMemo(
    () => [requests, privacy, justJoined, posts, rosterChanges],
    [requests, privacy, justJoined, posts, rosterChanges],
  );
  sourcesRef.current = sources;

  const rows = useMemo(() => buildFeedRows(sources.flatMap((source) => source.rows)), [sources]);

  /**
   * Sync this circle, then re-read. Only the log pass is awaited: photos
   * are nudged and left to their own queue, so the spinner ends when
   * captions and roster are current rather than when the last photo
   * finishes downloading.
   */
  const refresh = useCallback(async () => {
    if (!circleId) return;
    setRefreshing(true);
    try {
      await syncCircle(circleId);
      nudgePhotoQueue();
    } catch (err) {
      // An offline pull still re-reads below, so it shows whatever landed
      // last rather than an error over stale-but-valid content.
      console.error('Failed to sync on pull-to-refresh', err);
    } finally {
      await reload().catch((err) => console.error('Failed to reload the feed', err));
      setRefreshing(false);
    }
  }, [circleId, reload]);

  return {
    rows,
    circleName: feed?.circleName ?? '',
    memberCount: feed?.memberCount ?? 0,
    refreshing,
    reload,
    refresh,
  };
}
