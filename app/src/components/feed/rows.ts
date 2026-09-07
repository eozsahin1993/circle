import type { ReactElement } from 'react';

/**
 * The contract every feed row satisfies — the base each row module below
 * conforms to. Nothing inherits it: rows are plain objects, and TypeScript
 * is structural, so "extends" here means "has these fields" and no more.
 *
 * Every row answers the same questions itself: what identifies it, how
 * much air it wants, whether it stays put, where it sits in time, what
 * seeing it means, and how it draws. The screen then has no idea what
 * kinds exist — no union to widen, no `switch` in `renderItem`, no
 * pairwise spacing table. Adding a row type means adding a module and
 * listing it in the coordinator.
 */
export type FeedRow = {
  key: string;
  /**
   * The gap between two rows is the *smaller* of their two values, so a
   * quiet row tightens the space on both its sides without either
   * neighbour needing to know what it sits next to.
   */
  spacing: number;
  /** Stays pinned while the timeline scrolls under it. */
  sticky?: boolean;
  /** Set on rows that belong in the timeline; absent on pinned ones, which never sort. */
  at?: number;
  /**
   * Called once when the row has genuinely been on screen. Each row
   * decides what that means — a post marks its comments seen, a roster
   * change means nothing by being scrolled past.
   */
  onSeen?: () => void;
  /**
   * A thunk, not an element: FlatList renders lazily, and building every
   * row's element up front would defeat that on a long feed.
   */
  render: () => ReactElement;
};

/**
 * What every row hook returns, whatever kind it is.
 *
 * `reload` is optional because most kinds have nothing of their own to
 * refresh — their rows come from the feed the coordinator already loads.
 * A kind that owns state outside that read (join requests come from the
 * mailbox) exposes one, and the coordinator calls whichever exist without
 * knowing which kinds those are.
 */
export type FeedRows = {
  rows: FeedRow[];
  reload?: () => void;
};

/** What `ItemSeparatorComponent` puts between two rows — see `spacing`. */
export function gapBetween(leading: FeedRow, trailing: FeedRow | undefined): number {
  return trailing ? Math.min(leading.spacing, trailing.spacing) : leading.spacing;
}

/**
 * FlatList counts `ListHeaderComponent` as index 0, so a sticky data row
 * sits one further along than its position in `rows`. Index 0 is always
 * included: the circle header is sticky by definition.
 */
export function stickyIndices(rows: FeedRow[]): number[] {
  return [0, ...rows.flatMap((row, index) => (row.sticky ? [index + 1] : []))];
}

/**
 * Orders the feed. Takes rows already built — the caller decided which
 * kinds exist and which adapter each collection goes through — and does
 * the one thing that needs every row at once.
 *
 * Two bands, decided by the rows themselves: a row with no `at` is pinned
 * and keeps the position it was given, because it's about the circle
 * right now rather than something that happened at a moment. Everything
 * else interleaves by time, newest first — so a post and a roster change
 * sort together without either knowing the other exists.
 */
export function buildFeedRows(rows: FeedRow[]): FeedRow[] {
  return [
    ...rows.filter((row) => row.at === undefined),
    ...rows.filter((row) => row.at !== undefined).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
  ];
}
