import { useMemo } from 'react';

import type { FeedRow, FeedRows } from '@/components/feed/rows';
import { PrivacyNotice } from '@/components/privacy-notice';
import { Spacing } from '@/constants/theme';

/**
 * Scrolls away with the feed — it's list content, not part of the pinned
 * nav header, so it sits in the data rather than in `ListHeaderComponent`.
 */
export function usePrivacyRows(onPress: () => void): FeedRows {
  return useMemo(() => ({ rows: [privacyRow(onPress)] }), [onPress]);
}

export function privacyRow(onPress: () => void): FeedRow {
  return {
    key: 'privacy',
    spacing: Spacing.gapBetweenPosts,
    render: () => <PrivacyNotice onPress={onPress} />,
  };
}
