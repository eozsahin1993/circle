import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { CircleCard } from '@/components/circle-card';
import { EmptyCirclesIcon } from '@/components/empty-circles-icon';
import { FabButton } from '@/components/fab-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getAllCircles, getAllPendingJoinRequests, getCircleFeed, getCircleMembers, getProfile, type Circle } from '@/data/db';
import { checkPendingJoinRequest } from '@/domain/usecases/circle/join-circle';
import { bytesToDataUri } from '@/services/image';
import { nudgePhotoQueue } from '@/sync/photo-queue';
import { syncAllCircles } from '@/sync/sync-circles';

type CircleListItem = Circle & { memberCount: number; photoUri?: string };

export default function CircleListScreen() {
  const [avatarUri, setAvatarUri] = useState<string | undefined>();
  const [circles, setCircles] = useState<CircleListItem[]>([]);
  // Avoids flashing the empty state before the first load resolves.
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Re-check on every focus, not just mount — picture/circles may have just
  // changed on a screen this one returns to (profile, new circle, a post).
  /** Re-reads the circle list from the local database. No network. */
  const loadFromDatabase = useCallback(async () => {
    const profile = await getProfile();
    setAvatarUri(profile?.picture ? bytesToDataUri(profile.picture) : undefined);

    const allCircles = await getAllCircles();
    const withCounts = await Promise.all(
      allCircles.map(async (circle) => {
        const [members, posts] = await Promise.all([getCircleMembers(circle.id), getCircleFeed(circle.id)]);
        const coverBytes = circle.picture ?? posts[0]?.photo ?? undefined;
        return {
          ...circle,
          memberCount: members.length,
          photoUri: coverBytes ? bytesToDataUri(coverBytes) : undefined,
        };
      }),
    );
    setCircles(withCounts);
    setLoaded(true);
  }, []);

  // Re-check on every focus, not just mount — picture/circles may have just
  // changed on a screen this one returns to (profile, new circle, a post).
  useFocusEffect(
    useCallback(() => {
      loadFromDatabase().catch((err) => console.error('Failed to load circles', err));

      // Opportunistically completes a join even if the user never reopens
      // /join/pending directly — same app-lifecycle-triggered polling as
      // the rest of the invite flow (see server/INVITE_FLOW.md's goals).
      getAllPendingJoinRequests().then((requests) => {
        requests.forEach((request) => {
          checkPendingJoinRequest(request.id).catch((err) => console.error('Failed to check a pending join request', err));
        });
      });
    }, [loadFromDatabase]),
  );

  /** Syncs every circle, then re-reads. Photos are left to their own queue. */
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await syncAllCircles();
      nudgePhotoQueue();
    } finally {
      await loadFromDatabase().catch((err) => console.error('Failed to reload circles', err));
      setRefreshing(false);
    }
  }, [loadFromDatabase]);

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <View>
            <ThemedText type="eyebrow" style={styles.eyebrow}>
              Hearth
            </ThemedText>
            <ThemedText type="circleListHeader">Your Circles</ThemedText>
          </View>

          <Pressable onPress={() => router.push('/account')}>
            <Avatar size={44} uri={avatarUri} />
          </Pressable>
        </View>

        <FlatList
          data={loaded ? circles : []}
          keyExtractor={(circle) => circle.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          renderItem={({ item }) => (
            <CircleCard
              name={item.name}
              memberCount={item.memberCount}
              photoUri={item.photoUri}
              onPress={() => router.push({ pathname: '/feed', params: { circleId: item.id } })}
            />
          )}
          // Only once the first read has resolved — otherwise the empty
          // state flashes before the circles arrive.
          ListEmptyComponent={
            loaded ? (
              <View style={styles.empty}>
                <EmptyCirclesIcon />
                <ThemedText type="screenTitle" style={styles.emptyTitle}>
                  No circles yet
                </ThemedText>
                <ThemedText type="captionFeed" themeColor="muted" style={styles.emptyBody}>
                  Create one to share memories with the people in it — or join with a key someone
                  sent you.
                </ThemedText>
              </View>
            ) : null
          }
        />

        <FabButton
          icon="plus"
          onPress={() => router.push('/circle/new')}
          style={styles.fab}
        />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.topPadUnderStatusBar,
    gap: Spacing.cardListGap,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  eyebrow: {
    marginBottom: 2,
  },
  list: {
    // Grows to fill the screen so the empty state's `flex: 1` still has
    // height to centre itself in — a content container is otherwise only
    // as tall as its content, leaving the message pinned under the header.
    flexGrow: 1,
    gap: Spacing.cardListGap,
    paddingBottom: Spacing.cardListGap,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.screenPadding,
    gap: Spacing.cardListGap,
  },
  emptyTitle: {
    textAlign: 'center',
  },
  emptyBody: {
    textAlign: 'center',
  },
  fab: {
    position: 'absolute',
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
  },
});
