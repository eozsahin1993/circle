import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CircleHeader } from '@/components/circle-header';
import { FabButton } from '@/components/fab-button';
import { PostCard, type Post } from '@/components/post-card';
import { Spacing } from '@/constants/theme';
import { ThemedView } from '@/components/themed-view';
import { getCircle, getCircleMembers, getCirclePosts, getProfile } from '@/data/db';
import { bytesToDataUri } from '@/services/image';

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

export default function FeedScreen() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circleName, setCircleName] = useState('');
  const [memberCount, setMemberCount] = useState(0);
  const [posts, setPosts] = useState<Post[]>([]);

  useFocusEffect(
    useCallback(() => {
      if (!circleId) return;

      Promise.all([
        getCircle(circleId),
        getCircleMembers(circleId),
        getCirclePosts(circleId),
        getProfile(),
      ]).then(([circle, members, circlePosts, profile]) => {
        setCircleName(circle?.name ?? '');
        setMemberCount(members.length);
        setPosts(
          circlePosts.map((post) => ({
            id: post.id,
            authorName: profile?.name || 'You',
            timestamp: formatTimestamp(post.createdAt),
            photoUri: bytesToDataUri(post.photo),
            caption: post.caption,
            reactions: [],
            commentCount: 0,
          })),
        );
      });
    }, [circleId]),
  );

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <FlatList
          data={posts}
          keyExtractor={(post) => post.id}
          renderItem={({ item }) => <PostCard post={item} />}
          ListHeaderComponent={
            <ThemedView style={styles.header}>
              <CircleHeader name={circleName} memberCount={memberCount} />
            </ThemedView>
          }
          stickyHeaderIndices={[0]}
          ItemSeparatorComponent={() => <ThemedView style={{ height: Spacing.gapBetweenPosts }} />}
          contentContainerStyle={styles.list}
        />
        <FabButton
          icon="+"
          onPress={() => router.push({ pathname: '/post/new', params: { circleId } })}
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
  },
  header: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: 6,
    paddingBottom: Spacing.gapBetweenPosts,
  },
  list: {
    paddingBottom: 100,
  },
  fab: {
    position: 'absolute',
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
  },
});
