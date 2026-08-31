import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CircleHeader } from '@/components/circle-header';
import { FabButton } from '@/components/fab-button';
import { PostCard, type Post } from '@/components/post-card';
import { PrivacyInfoModal } from '@/components/privacy-info-modal';
import { PrivacyNotice } from '@/components/privacy-notice';
import { Spacing } from '@/constants/theme';
import { ThemedView } from '@/components/themed-view';
import { getCircle, getCircleMembers, getCirclePosts, getPostComments, getProfile } from '@/data/db';
import { addComment } from '@/domain/usecases/comment-on-post';
import { getReactionsForPost, toggleReaction } from '@/domain/usecases/react-to-post';
import { bytesToDataUri } from '@/services/image';

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

// The privacy notice scrolls away with the feed — it's list content, not
// part of the pinned nav header — so it rides along as row zero of `data`
// rather than living inside `ListHeaderComponent`.
type FeedRow = { kind: 'privacy' } | { kind: 'post'; post: Post };

export default function FeedScreen() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circleName, setCircleName] = useState('');
  const [memberCount, setMemberCount] = useState(0);
  const [posts, setPosts] = useState<Post[]>([]);
  const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!circleId) return;

      Promise.all([
        getCircle(circleId),
        getCircleMembers(circleId),
        getCirclePosts(circleId),
        getProfile(),
      ]).then(async ([circle, members, circlePosts, profile]) => {
        setCircleName(circle?.name ?? '');
        setMemberCount(members.length);
        const authorPhotoUri = profile?.picture ? bytesToDataUri(profile.picture) : undefined;

        const [reactionsByPost, commentsByPost] = await Promise.all([
          Promise.all(circlePosts.map((post) => getReactionsForPost(circleId, post.id))),
          Promise.all(circlePosts.map((post) => getPostComments(post.id))),
        ]);

        setPosts(
          circlePosts.map((post, index) => ({
            id: post.id,
            authorName: profile?.name || 'You',
            authorPhotoUri,
            timestamp: formatTimestamp(post.createdAt),
            photoUri: bytesToDataUri(post.photo),
            caption: post.caption,
            reactions: reactionsByPost[index],
            comments: commentsByPost[index],
          })),
        );
      });
    }, [circleId]),
  );

  async function handleToggleReaction(postId: string, emoji: string) {
    if (!circleId) return;
    await toggleReaction(circleId, postId, emoji);
    const reactions = await getReactionsForPost(circleId, postId);
    setPosts((current) => current.map((post) => (post.id === postId ? { ...post, reactions } : post)));
  }

  async function handleAddComment(postId: string, body: string) {
    if (!circleId) return;
    await addComment(circleId, postId, body);
    const comments = await getPostComments(postId);
    setPosts((current) => current.map((post) => (post.id === postId ? { ...post, comments } : post)));
  }

  const rows: FeedRow[] = [{ kind: 'privacy' }, ...posts.map((post) => ({ kind: 'post' as const, post }))];

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <FlatList
          data={rows}
          keyExtractor={(row) => (row.kind === 'privacy' ? 'privacy' : row.post.id)}
          renderItem={({ item }) =>
            item.kind === 'privacy' ? (
              <PrivacyNotice onPress={() => setShowPrivacyInfo(true)} />
            ) : (
              <PostCard
                post={item.post}
                onToggleReaction={(emoji) => handleToggleReaction(item.post.id, emoji)}
                onAddComment={(body) => handleAddComment(item.post.id, body)}
              />
            )
          }
          ListHeaderComponent={
            <ThemedView style={styles.header}>
              <CircleHeader
                name={circleName}
                memberCount={memberCount}
                onPressDetails={() => router.push({ pathname: '/circle/details', params: { circleId } })}
              />
            </ThemedView>
          }
          stickyHeaderIndices={[0]}
          ItemSeparatorComponent={() => <ThemedView style={{ height: Spacing.gapBetweenPosts }} />}
          contentContainerStyle={styles.list}
        />
        <FabButton
          icon="plus"
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
