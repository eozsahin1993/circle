import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View, type ViewToken } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FabButton } from '@/components/fab-button';
import { gapBetween, stickyIndices, type FeedRow } from '@/components/feed/rows';
import { HeaderIconButton } from '@/components/navbar/header-icon-button';
import { PrivacyInfoModal } from '@/components/privacy-info-modal';
import { ScreenHeader } from '@/components/navbar/screen-header';
import { ThemedView } from '@/components/themed-view';
import { Icons, Spacing } from '@/constants/theme';
import { markCircleViewed } from '@/data/db';
import { useCircleFeed } from '@/hooks/use-circle-feed';

/**
 * One circle's feed. `useCircleFeed` owns the data and the actions on it,
 * `buildFeedRows` decides what rows exist and in what order, and this
 * renders whatever comes back — so it has no idea what kinds of row there
 * are, and gains no branch when a new one is added.
 */
export default function FeedScreen() {
  const { circleId, justJoined } = useLocalSearchParams<{ circleId: string; justJoined?: string }>();
  const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);
  const onPressPrivacy = useCallback(() => setShowPrivacyInfo(true), []);
  const openDetails = useCallback(
    () => router.push({ pathname: '/circle/details', params: { circleId } }),
    [circleId],
  );
  const { rows, circleName, memberCount, refreshing, reload, refresh } = useCircleFeed(circleId, {
    justJoined: justJoined === '1',
    onPressPrivacy,
  });

  useFocusEffect(
    useCallback(() => {
      reload().catch((err) => console.error('Failed to load the feed', err));
      // A new post sorts to the top of the feed, so simply opening it is
      // genuine proof it was seen — unlike a comment, which can land on any
      // post regardless of age (see the viewability tracking below).
      if (circleId) markCircleViewed(circleId).catch((err) => console.error('Failed to mark the circle viewed', err));
    }, [circleId, reload]),
  );

  /**
   * Tells a row it has genuinely been on screen — what that means is the
   * row's own business (see `onSeen`). Deduped per screen instance: a row
   * sitting in view shouldn't fire on every viewability recompute.
   */
  const [seenRowKeys] = useState(() => new Set<string>());
  const [onViewableItemsChanged] = useState(
    () =>
      ({ viewableItems }: { viewableItems: ViewToken<FeedRow>[] }) => {
        for (const { item } of viewableItems) {
          if (!item.onSeen || seenRowKeys.has(item.key)) continue;
          seenRowKeys.add(item.key);
          item.onSeen();
        }
      },
  );
  const [viewabilityConfig] = useState(() => ({ itemVisiblePercentThreshold: 50 }));

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        {/* Outside the list, like every other screen's header — so it
            stays put rather than scrolling, and the refresh spinner comes
            down from under it instead of over it. */}
        <View style={styles.headerInset}>
          <ScreenHeader
            title={circleName}
            subtitle={`${memberCount} people. Tap for details`}
            onPressTitle={openDetails}
            actions={
              <>
                <HeaderIconButton
                  icon={Icons.album}
                  accessibilityLabel="Album"
                  onPress={() => router.push({ pathname: '/circle/album', params: { circleId } })}
                />
                <HeaderIconButton icon={Icons.more} accessibilityLabel="Circle details" onPress={openDetails} />
              </>
            }
          />
        </View>

        <FlatList
          data={rows}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => item.render()}
          stickyHeaderIndices={stickyIndices(rows)}
          // Without this the first tap on send (next to an expanded post's
          // comment input) only dismisses the keyboard, so the comment
          // needs tapping twice.
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={({ leadingItem }: { leadingItem?: FeedRow }) => {
            if (!leadingItem) return null;
            const index = rows.indexOf(leadingItem);
            return <ThemedView style={{ height: gapBetween(leadingItem, rows[index + 1]) }} />;
          }}
          contentContainerStyle={styles.list}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
        />
        <FabButton
          icon={Icons.composePost}
          onPress={() => router.push({ pathname: '/post/new', params: { circleId } })}
          style={styles.fab}
        />
      </SafeAreaView>

      <PrivacyInfoModal visible={showPrivacyInfo} onClose={() => setShowPrivacyInfo(false)} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  headerInset: {
    paddingHorizontal: Spacing.feedTextPadding,
  },
  list: {
    // On top of the header's own bottom margin: the first row is feed
    // content arriving under fixed chrome, not the next line of it.
    paddingTop: Spacing.cardListGap,
    paddingBottom: 100,
  },
  fab: {
    position: 'absolute',
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
  },
});
