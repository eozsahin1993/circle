import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CircleHeader } from '@/components/circle-header';
import { FabButton } from '@/components/fab-button';
import { PendingJoinRequestCard } from '@/components/pending-join-request-card';
import { PostCard, type Post } from '@/components/post-card';
import { PrivacyInfoModal } from '@/components/privacy-info-modal';
import { PrivacyNotice } from '@/components/privacy-notice';
import { Radius, Spacing } from '@/constants/theme';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { getCircle, getCircleMembers, getCirclePosts, getPostComments, getProfile } from '@/data/db';
import {
  approveJoinRequest,
  denyJoinRequest,
  discoverPendingRequests,
  type PendingRequest,
} from '@/domain/usecases/circle/invite-to-circle';
import { addComment } from '@/domain/usecases/post/comment-on-post';
import { getReactionsForPost, toggleReaction } from '@/domain/usecases/post/react-to-post';
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
type FeedRow =
  | { kind: 'privacy' }
  | { kind: 'just-joined' }
  | { kind: 'pending-request'; request: PendingRequest }
  | { kind: 'post'; post: Post };

export default function FeedScreen() {
  const { circleId, justJoined } = useLocalSearchParams<{ circleId: string; justJoined?: string }>();
  const [circleName, setCircleName] = useState('');
  const [memberCount, setMemberCount] = useState(0);
  const [posts, setPosts] = useState<Post[]>([]);
  const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [actioningId, setActioningId] = useState<string | null>(null);

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

      // Only ever resolves non-empty for this invite's actual creator (see
      // discoverPendingRequests's creator-only gate) — silently shows
      // nothing for anyone else, same as circle/invite.tsx's own section.
      discoverPendingRequests(circleId)
        .then(setPendingRequests)
        .catch(() => setPendingRequests([]));
    }, [circleId]),
  );

  async function handleApprove(requesterId: string) {
    if (!circleId) return;
    setActioningId(requesterId);
    try {
      await approveJoinRequest(circleId, requesterId);
      setPendingRequests((current) => current.filter((request) => request.requesterId !== requesterId));
    } catch (err) {
      console.error('Failed to approve join request', err);
    } finally {
      setActioningId(null);
    }
  }

  async function handleDeny(requesterId: string) {
    if (!circleId) return;
    setActioningId(requesterId);
    try {
      await denyJoinRequest(circleId, requesterId);
      setPendingRequests((current) => current.filter((request) => request.requesterId !== requesterId));
    } catch (err) {
      console.error('Failed to dismiss join request', err);
    } finally {
      setActioningId(null);
    }
  }

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

  // A fresh joiner has the circle secret and roster access but no history
  // yet — pullCircle (syncing an existing circle's past entries) doesn't
  // exist yet (see server/INVITE_FLOW.md's "what this flow depends on
  // that isn't built yet"). Honest about the gap rather than looking
  // broken: only shows while the feed is actually empty, and disappears
  // for good once any post shows up.
  const showJustJoinedBanner = justJoined === '1' && posts.length === 0;

  const rows: FeedRow[] = [
    ...pendingRequests.map((request) => ({ kind: 'pending-request' as const, request })),
    { kind: 'privacy' },
    ...(showJustJoinedBanner ? [{ kind: 'just-joined' as const }] : []),
    ...posts.map((post) => ({ kind: 'post' as const, post })),
  ];

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <FlatList
          data={rows}
          keyExtractor={(row) => {
            if (row.kind === 'post') return row.post.id;
            if (row.kind === 'pending-request') return row.request.requesterId;
            return row.kind;
          }}
          renderItem={({ item }) => {
            if (item.kind === 'privacy') return <PrivacyNotice onPress={() => setShowPrivacyInfo(true)} />;
            if (item.kind === 'just-joined') {
              return (
                <ThemedView style={styles.justJoined} type="surface">
                  <ThemedText type="cardTitle">You&apos;re in!</ThemedText>
                  <ThemedText type="meta" themeColor="muted">
                    Content will sync soon.
                  </ThemedText>
                </ThemedView>
              );
            }
            if (item.kind === 'pending-request') {
              return (
                <ThemedView style={styles.pendingRequestRow}>
                  <PendingJoinRequestCard
                    request={item.request}
                    busy={actioningId !== null}
                    onApprove={() => handleApprove(item.request.requesterId)}
                    onDeny={() => handleDeny(item.request.requesterId)}
                  />
                </ThemedView>
              );
            }
            return (
              <PostCard
                post={item.post}
                onToggleReaction={(emoji) => handleToggleReaction(item.post.id, emoji)}
                onAddComment={(body) => handleAddComment(item.post.id, body)}
              />
            );
          }}
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
  justJoined: {
    marginHorizontal: Spacing.screenPadding,
    marginTop: Spacing.gapBetweenPosts,
    padding: 16,
    borderRadius: Radius.panel,
    alignItems: 'center',
    gap: 2,
  },
  pendingRequestRow: {
    marginHorizontal: Spacing.cardListGap,
  },
  fab: {
    position: 'absolute',
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
  },
});
