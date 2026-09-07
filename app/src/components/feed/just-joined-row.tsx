import { useMemo } from 'react';
import { StyleSheet } from 'react-native';

import type { FeedRow, FeedRows } from '@/components/feed/rows';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';

export type JustJoinedRowsInput = {
  /** Whether this arrival was a join at all — the route carries that, not the feed. */
  justJoined: boolean;
  /** How much history has landed. The banner is only honest while there is none. */
  postCount: number;
};

/**
 * A fresh joiner has the circle secret and roster access but no history
 * yet — pullCircle (syncing an existing circle's past entries) doesn't
 * exist yet (see server/INVITE_FLOW.md). Honest about the gap rather than
 * looking broken.
 *
 * Both halves of "should this show" live here, and neither is a condition
 * the coordinator has to remember: empty when it shouldn't show.
 */
export function useJustJoinedRows({ justJoined, postCount }: JustJoinedRowsInput): FeedRows {
  return useMemo(() => ({ rows: justJoined && postCount === 0 ? [justJoinedRow()] : [] }), [justJoined, postCount]);
}

export function justJoinedRow(): FeedRow {
  return {
    key: 'just-joined',
    spacing: Spacing.gapBetweenPosts,
    render: () => (
      <ThemedView style={styles.banner} type="surface">
        <ThemedText type="cardTitle">You&apos;re in!</ThemedText>
        <ThemedText type="meta" themeColor="muted">
          Content will sync soon.
        </ThemedText>
      </ThemedView>
    ),
  };
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: Spacing.feedTextPadding,
    marginTop: Spacing.gapBetweenPosts,
    padding: 16,
    borderRadius: Radius.panel,
    alignItems: 'center',
    gap: 2,
  },
});
