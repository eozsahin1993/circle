import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { CircleCard } from '@/components/circle-card';
import { FabButton } from '@/components/fab-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getAllCircles, getCircleMembers, getProfile, type Circle } from '@/data/db';
import { bytesToDataUri } from '@/services/image';

type CircleListItem = Circle & { memberCount: number };

export default function CircleListScreen() {
  const [avatarUri, setAvatarUri] = useState<string | undefined>();
  const [circles, setCircles] = useState<CircleListItem[]>([]);

  // Re-check on every focus, not just mount — picture/circles may have just
  // changed on a screen this one returns to (profile, new circle, a post).
  useFocusEffect(
    useCallback(() => {
      getProfile().then((profile) => {
        setAvatarUri(profile?.picture ? bytesToDataUri(profile.picture) : undefined);
      });

      getAllCircles().then(async (allCircles) => {
        const withCounts = await Promise.all(
          allCircles.map(async (circle) => ({
            ...circle,
            memberCount: (await getCircleMembers(circle.id)).length,
          })),
        );
        setCircles(withCounts);
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

          <Pressable onPress={() => router.push('/profile-setup')}>
            <Avatar size={44} uri={avatarUri} />
          </Pressable>
        </View>

        {circles.map((circle) => (
          <CircleCard
            key={circle.id}
            name={circle.name}
            memberCount={circle.memberCount}
            onPress={() => router.push({ pathname: '/feed', params: { circleId: circle.id } })}
          />
        ))}

        <FabButton
          icon="+"
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
  fab: {
    position: 'absolute',
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
  },
});
