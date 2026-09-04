import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CircleHeader } from '@/components/circle-header';
import { FabButton } from '@/components/fab-button';
import { PendingJoinRequestCard } from '@/components/pending-join-request-card';
import { type CommentItem } from '@/components/post-comments';
import { PostCard, type Post } from '@/components/post-card';
import { PrivacyInfoModal } from '@/components/privacy-info-modal';
import { PrivacyNotice } from '@/components/privacy-notice';
import { Radius, Spacing } from '@/constants/theme';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { getCircle, getCircleFeed, getCircleMembers, getPostComments, getProfile, type CommentWithAuthor } from '@/data/db';
import {
  approveJoinRequest,
  denyJoinRequest,
  discoverPendingRequests,
  type PendingRequest,
} from '@/domain/usecases/circle/invite-to-circle';
import { addComment } from '@/domain/usecases/post/comment-on-post';
import { getReactionsForPost, toggleReaction } from '@/domain/usecases/post/react-to-post';
import { bytesToDataUri } from '@/services/image';
import { nudgePhotoQueue } from '@/sync/photo-queue';
import { syncCircle } from '@/sync/sync-circles';

/**
 * Author names on comments resolve live from the roster, so a member
 * renaming themselves updates every comment they wrote. Falls back to this
 * device's own profile for a comment written before its author's roster
 * row arrived — which is the local author's own comments, pre-sync.
 */
function toCommentItems(comments: CommentWithAuthor[], ownName?: string): CommentItem[] {
  return comments.map((comment) => ({
    id: comment.id,
    authorName: comment.authorName || ownName || 'Unknown member',
    body: comment.body,
  }));
}

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
  // Kept at component scope so re-reading one post's comments after adding
  // one can resolve the local author's name the same way the initial load does.
  const [profileName, setProfileName] = useState<string | undefined>();
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Re-reads everything this screen shows from the local database. Never
   * touches the network: sync writes to SQLite and this renders what's
   * there, so the two stay independent and a slow relay can't stall a
   * repaint.
   */
  const loadFromDatabase = useCallback(async () => {
    if (!circleId) return;

    const [circle, members, circlePosts, profile] = await Promise.all([
      getCircle(circleId),
      getCircleMembers(circleId),
      getCircleFeed(circleId),
      getProfile(),
    ]);

    setCircleName(circle?.name ?? '');
    setMemberCount(members.length);
    setProfileName(profile?.name);

    const [reactionsByPost, commentsByPost] = await Promise.all([
      Promise.all(circlePosts.map((post) => getReactionsForPost(circleId, post.id))),
      Promise.all(circlePosts.map((post) => getPostComments(circleId, post.id))),
    ]);

    // Author name/picture already came resolved from the roster by
    // `getCircleFeed` — this screen only turns bytes into data URIs
    // and timestamps into strings. Falls back to this device's own
    // profile for a post whose author has no roster row yet.
    setPosts(
      circlePosts.map((post, index) => ({
        id: post.id,
        authorName: post.authorName || profile?.name || 'Unknown member',
        authorPhotoUri: (post.authorPicture ?? profile?.picture)
          ? bytesToDataUri(post.authorPicture ?? profile!.picture!)
          : undefined,
        timestamp: formatTimestamp(post.createdAt),
        // Undefined while the photo is still queued for download —
        // PostCard renders its placeholder rather than a broken image.
        photoUri: post.photo ? bytesToDataUri(post.photo) : undefined,
        caption: post.caption,
        reactions: reactionsByPost[index],
        comments: toCommentItems(commentsByPost[index], profile?.name),
      })),
    );

    // Only ever resolves non-empty for this invite's actual creator (see
    // discoverPendingRequests's creator-only gate) — silently shows
    // nothing for anyone else, same as circle/invite.tsx's own section.
    discoverPendingRequests(circleId)
      .then(setPendingRequests)
      .catch(() => setPendingRequests([]));
  }, [circleId]);

  useFocusEffect(
    useCallback(() => {
      loadFromDatabase().catch((err) => console.error('Failed to load the feed', err));
    }, [loadFromDatabase]),
  );

  /**
   * Pull-to-refresh: sync this circle, then re-read. Without it the only
   * triggers are app start, returning to the foreground, and a 45s timer,
   * so someone sitting on the feed waiting for a post has no way to ask.
   *
   * Only the log pass is awaited. Photos are nudged and left to their own
   * queue, so the spinner ends when captions and roster are current rather
   * than when the last photo finishes downloading.
   */
  const handleRefresh = useCallback(async () => {
    if (!circleId) return;
    setRefreshing(true);
    try {
      await syncCircle(circleId);
      nudgePhotoQueue();
    } catch (err) {
      // An offline pull still re-reads below, so it shows whatever landed
      // last rather than an error over stale-but-valid content.
      console.error('Failed to sync on pull-to-refresh', err);
    } finally {
      await loadFromDatabase().catch((err) => console.error('Failed to reload the feed', err));
      setRefreshing(false);
    }
  }, [circleId, loadFromDatabase]);

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
    const comments = await getPostComments(circleId, postId);
    setPosts((current) =>
      current.map((post) => (post.id === postId ? { ...post, comments: toCommentItems(comments, profileName) } : post)),
    );
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
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
