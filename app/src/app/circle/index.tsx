import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { CircleCard } from '@/components/circle-card';
import { EmptyCirclesIcon } from '@/components/empty-circles-icon';
import { FabButton } from '@/components/fab-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getAllCircles, getAllPendingJoinRequests, getCircleMembers, getCirclePosts, getProfile, type Circle } from '@/data/db';
import { checkPendingJoinRequest } from '@/domain/usecases/circle/join-circle';
import { bytesToDataUri } from '@/services/image';

type CircleListItem = Circle & { memberCount: number; photoUri?: string };

export default function CircleListScreen() {
  const [avatarUri, setAvatarUri] = useState<string | undefined>();
  const [circles, setCircles] = useState<CircleListItem[]>([]);
  // Avoids flashing the empty state before the first load resolves.
  const [loaded, setLoaded] = useState(false);

  // Re-check on every focus, not just mount — picture/circles may have just
  // changed on a screen this one returns to (profile, new circle, a post).
  useFocusEffect(
    useCallback(() => {
      getProfile().then((profile) => {
        setAvatarUri(profile?.picture ? bytesToDataUri(profile.picture) : undefined);
      });

      getAllCircles().then(async (allCircles) => {
        const withCounts = await Promise.all(
          allCircles.map(async (circle) => {
            const [members, posts] = await Promise.all([
              getCircleMembers(circle.id),
              getCirclePosts(circle.id),
            ]);
            const coverBytes = circle.picture ?? posts[0]?.photo;
            return {
              ...circle,
              memberCount: members.length,
              photoUri: coverBytes ? bytesToDataUri(coverBytes) : undefined,
            };
          }),
        );
        setCircles(withCounts);
        setLoaded(true);
      });

      // Opportunistically completes a join even if the user never reopens
      // /join/pending directly — same app-lifecycle-triggered polling as
      // the rest of the invite flow (see server/INVITE_FLOW.md's goals).
      getAllPendingJoinRequests().then((requests) => {
        requests.forEach((request) => {
          checkPendingJoinRequest(request.id).catch((err) => console.error('Failed to check a pending join request', err));
        });
      });
    }, []),
  );

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

        {loaded && circles.length === 0 ? (
          <View style={styles.empty}>
            <EmptyCirclesIcon />
            <ThemedText type="screenTitle" style={styles.emptyTitle}>
              No circles yet
            </ThemedText>
            <ThemedText type="captionFeed" themeColor="muted" style={styles.emptyBody}>
              Create one to share memories with the people in it — or join with a key someone sent
              you.
            </ThemedText>
          </View>
        ) : (
          circles.map((circle) => (
            <CircleCard
              key={circle.id}
              name={circle.name}
              memberCount={circle.memberCount}
              photoUri={circle.photoUri}
              onPress={() => router.push({ pathname: '/feed', params: { circleId: circle.id } })}
            />
          ))
        )}

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
