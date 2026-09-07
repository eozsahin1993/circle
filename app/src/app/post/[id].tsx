import { Feather } from '@expo/vector-icons';
import { bytesToHex } from '@noble/curves/utils.js';
import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { KeyboardAvoider } from '@/components/keyboard-avoider';
import { BackButton } from '@/components/back-button';
import { FabButton } from '@/components/fab-button';
import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { ReactionChip } from '@/components/reaction-chip';
import { EmojiPicker } from '@/components/emoji-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Icons, PhotoAspect, Radius, Spacing, Tints } from '@/constants/theme';
import {
  getAttachment,
  getCircleMemberCount,
  getCircleSummary,
  getFeedPost,
  getPostComments,
  getProfile,
  markPostViewed,
  getPostReactors,
  type CommentWithAuthor,
  type FeedPost,
  type ReactionSummary,
} from '@/data/db';
import { isCircleAdmin } from '@/domain/usecases/circle/invite-to-circle';
import { addComment } from '@/domain/usecases/post/comment-on-post';
import { getReactionsForPost, toggleReaction } from '@/domain/usecases/post/react-to-post';
import { setAlbumVisibility } from '@/domain/usecases/post/set-album-visibility';
import { useTheme } from '@/hooks/use-theme';
import { bytesToDataUri } from '@/services/image';
import { getCircleIdentity } from '@/services/keystore';
import { ensurePhotoUri, writePhotoFile } from '@/services/photo-cache';
import { formatRelative, formatTimestamp } from '@/utils/time';

/** Names shown before the rest become "& N others" — enough to recognise who, not a roster dump. */
const PREVIEW_NAMES = 3;

export default function PostDetailsScreen() {
  const theme = useTheme();
  const { id: postId, circleId } = useLocalSearchParams<{ id: string; circleId: string }>();

  const [circleName, setCircleName] = useState('');
  const [memberCount, setMemberCount] = useState(0);
  const [post, setPost] = useState<FeedPost | null>(null);
  const [photoUri, setPhotoUri] = useState<string | undefined>();
  const [profileName, setProfileName] = useState<string | undefined>();
  const [reactions, setReactions] = useState<ReactionSummary[]>([]);
  const [reactors, setReactors] = useState<string[]>([]);
  const [comments, setComments] = useState<CommentWithAuthor[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [showAllReactors, setShowAllReactors] = useState(false);
  const [commentText, setCommentText] = useState('');
  /** The author or an admin, and nobody else — see set-album-visibility.ts. */
  const [canEditAlbum, setCanEditAlbum] = useState(false);

  const load = useCallback(async () => {
    if (!circleId || !postId) return;

    const [circle, count, feedPost, profile, reactionSummary, details, postComments, identity, isAdmin] =
      await Promise.all([
        getCircleSummary(circleId),
        getCircleMemberCount(circleId),
        getFeedPost(circleId, postId),
        getProfile(),
        getReactionsForPost(circleId, postId),
        getPostReactors(circleId, postId),
        getPostComments(circleId, postId),
        getCircleIdentity(circleId),
        isCircleAdmin(circleId),
      ]);

    setCircleName(circle?.name ?? '');
    setMemberCount(count);
    setPost(feedPost);
    setProfileName(profile?.name);
    setReactions(reactionSummary);
    setReactors(details);
    setComments(postComments);
    setCanEditAlbum(isAdmin || (identity != null && bytesToHex(identity.publicKey) === feedPost?.authorPublicKey));

    if (feedPost?.hasPhoto) {
      let uri = ensurePhotoUri(circleId, postId, () => null);
      if (!uri) {
        const attachment = await getAttachment(circleId, postId);
        if (attachment?.bytes) uri = writePhotoFile(circleId, postId, attachment.bytes);
      }
      setPhotoUri(uri ?? undefined);
    } else {
      setPhotoUri(undefined);
    }

    // Covers a post the feed hasn't rendered yet (e.g. a future deep link
    // straight into one) — the feed's own scroll-viewability tracking
    // already covers the ordinary case of getting here from it.
    markPostViewed(postId).catch((err) => console.error('Failed to mark the post viewed', err));
  }, [circleId, postId]);

  useFocusEffect(
    useCallback(() => {
      load().catch((err) => console.error('Failed to load post details', err));
    }, [load]),
  );

  async function handleSelectReaction(emoji: string) {
    if (!circleId || !postId) return;
    await toggleReaction(circleId, postId, emoji);
    const [summary, details] = await Promise.all([
      getReactionsForPost(circleId, postId),
      getPostReactors(circleId, postId),
    ]);
    setReactions(summary);
    setReactors(details);
    setShowPicker(false);
  }

  async function handleToggleAlbum() {
    if (!circleId || !postId || !post) return;
    const next = !post.inAlbum;
    // Optimistic: the write is local-first and the entry is queued, so
    // the only thing left to wait on is a network push that must never
    // hold the button up.
    setPost({ ...post, inAlbum: next });
    try {
      await setAlbumVisibility(circleId, postId, next);
    } catch (err) {
      console.error('Failed to change album visibility', err);
      setPost({ ...post, inAlbum: post.inAlbum });
    }
  }

  async function handleSubmitComment() {
    if (!circleId || !postId || !commentText.trim()) return;
    const body = commentText;
    setCommentText('');
    await addComment(circleId, postId, body);
    setComments(await getPostComments(circleId, postId));
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <BackButton />
          <ThemedText type="postAuthor" style={styles.headerText} numberOfLines={1}>
            {circleName} · visible to {memberCount} {memberCount === 1 ? 'person' : 'people'}
          </ThemedText>
          {/* Filing a photo is about the post as a whole, so it sits with
              the post rather than among the reaction chips, which are each
              about one emoji. Shown only to whoever may actually change it. */}
          {post && canEditAlbum ? (
            <Pressable style={styles.albumButton} onPress={handleToggleAlbum} hitSlop={8}>
              <Feather name={Icons.inAlbum} size={16} color={post.inAlbum ? theme.accentBright : theme.secondary} />
              <ThemedText type="meta" themeColor={post.inAlbum ? 'accentBright' : 'secondary'}>
                {post.inAlbum ? 'In album' : 'Add to album'}
              </ThemedText>
            </Pressable>
          ) : null}
        </View>

        <KeyboardAvoider style={styles.body}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            {photoUri ? (
              <Image source={{ uri: photoUri }} style={styles.photo} contentFit="cover" />
            ) : (
              <PhotoPlaceholder style={styles.photo} />
            )}

            {post ? (
              <>
                {post.caption ? (
                  <ThemedText type="captionDetail" style={styles.caption}>
                    {post.caption}
                  </ThemedText>
                ) : null}
                {/* Without a caption the byline takes its place under the
                    photo, rather than sitting tight against it. The album
                    marker shows for everyone; only the author or an admin
                    gets the control above that changes it. */}
                <View style={[styles.byline, post.caption ? null : styles.bylineAlone]}>
                  <ThemedText type="meta" themeColor="muted">
                    {post.authorName || profileName || 'Unknown member'} · {formatTimestamp(post.createdAt)}
                  </ThemedText>
                  {post.inAlbum ? (
                    <>
                      <ThemedText type="meta" themeColor="muted">
                        ·
                      </ThemedText>
                      <Feather name={Icons.inAlbum} size={12} color={theme.secondary} />
                      <ThemedText type="meta" themeColor="secondary">
                        In the album
                      </ThemedText>
                    </>
                  ) : null}
                </View>
              </>
            ) : null}

            <View style={styles.reactions}>
              {reactions.map((reaction) => (
                <ReactionChip
                  key={reaction.emoji}
                  emoji={reaction.emoji}
                  label={String(reaction.count)}
                  reacted={reaction.reactedByMe}
                  onPress={() => handleSelectReaction(reaction.emoji)}
                />
              ))}
              <ReactionChip label="+" onPress={() => setShowPicker((v) => !v)} />
            </View>

            {showPicker ? (
              <View style={styles.picker}>
                <EmojiPicker onSelect={handleSelectReaction} onClose={() => setShowPicker(false)} />
              </View>
            ) : null}

            {/* Who reacted, as people rather than per emoji — the chips
                above already carry which emoji and how many. */}
            {reactors.length > 0 ? (
              <ThemedText type="comment" themeColor="secondary" style={styles.reactors}>
                {(showAllReactors ? reactors : reactors.slice(0, PREVIEW_NAMES)).join(', ')}
                {!showAllReactors && reactors.length > PREVIEW_NAMES
                  ? ` & ${reactors.length - PREVIEW_NAMES} other${reactors.length - PREVIEW_NAMES === 1 ? '' : 's'}`
                  : null}
                {reactors.length > PREVIEW_NAMES ? (
                  <>
                    {'. '}
                    {/* Nested so it flows with the names instead of being
                        pinned somewhere a long list can't wrap to. */}
                    <ThemedText type="comment" themeColor="accentBright" onPress={() => setShowAllReactors((v) => !v)}>
                      {showAllReactors ? 'See less' : 'See all'}
                    </ThemedText>
                  </>
                ) : null}
              </ThemedText>
            ) : null}

            {comments.length > 0 ? <View style={[styles.divider, { backgroundColor: theme.faintest }]} /> : null}

            <View style={styles.comments}>
              {comments.map((comment) => (
                <View key={comment.id} style={styles.commentRow}>
                  <Avatar
                    size={36}
                    uri={comment.authorPicture ? bytesToDataUri(comment.authorPicture) : undefined}
                  />
                  <View style={styles.commentBody}>
                    <View style={styles.commentByline}>
                      <ThemedText type="postAuthor">{comment.authorName || profileName || 'Unknown member'}</ThemedText>
                      <ThemedText type="meta" themeColor="faint">
                        {formatRelative(comment.createdAt)}
                      </ThemedText>
                    </View>
                    <ThemedText type="comment" themeColor="secondary">
                      {comment.body}
                    </ThemedText>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>

          <View style={styles.composer}>
            <TextInput
              value={commentText}
              onChangeText={setCommentText}
              onSubmitEditing={handleSubmitComment}
              placeholder="Say something to the circle"
              placeholderTextColor={theme.faint}
              returnKeyType="send"
              style={[styles.composerInput, { color: theme.text, borderColor: theme.faint }]}
            />
            <FabButton
              icon={Icons.send}
              size={44}
              disabled={!commentText.trim()}
              onPress={handleSubmitComment}
              style={!commentText.trim() ? styles.composerSendDisabled : undefined}
            />
          </View>
        </KeyboardAvoider>
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.topPadUnderStatusBar,
    paddingBottom: Spacing.cardListGap,
  },
  headerText: {
    flex: 1,
  },
  albumButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Tints.secondaryButtonBorder,
  },
  body: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: Spacing.cardListGap,
  },
  photo: {
    aspectRatio: PhotoAspect.post,
  },
  caption: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.cardListGap,
  },
  byline: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 5,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: 6,
  },
  bylineAlone: {
    paddingTop: Spacing.cardListGap,
  },
  reactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.cardListGap,
  },
  picker: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: 12,
  },
  reactors: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: 14,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.screenPadding,
    marginTop: Spacing.cardListGap + 4,
  },
  comments: {
    gap: 14,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.cardListGap,
  },
  commentRow: {
    flexDirection: 'row',
    gap: 12,
  },
  commentByline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  commentBody: {
    flex: 1,
    gap: 2,
    paddingTop: 2,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: Spacing.screenPadding,
    paddingVertical: 12,
  },
  composerInput: {
    flex: 1,
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    fontSize: 14,
  },
  composerSendDisabled: {
    opacity: 0.4,
  },
});
