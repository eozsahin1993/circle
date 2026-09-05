import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { BackButton } from '@/components/back-button';
import { FabButton } from '@/components/fab-button';
import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { ReactionChip } from '@/components/reaction-chip';
import { ReactionPicker } from '@/components/reaction-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { PhotoAspect, Spacing } from '@/constants/theme';
import {
  getAttachment,
  getCircleMemberCount,
  getCircleSummary,
  getFeedPost,
  getPostComments,
  getProfile,
  type CommentWithAuthor,
  type FeedPost,
  type ReactionSummary,
} from '@/data/db';
import { addComment } from '@/domain/usecases/post/comment-on-post';
import { getReactionsForPost, toggleReaction } from '@/domain/usecases/post/react-to-post';
import { useTheme } from '@/hooks/use-theme';
import { bytesToDataUri } from '@/services/image';
import { ensurePhotoUri, writePhotoFile } from '@/services/photo-cache';

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

export default function PostDetailsScreen() {
  const theme = useTheme();
  const { id: postId, circleId } = useLocalSearchParams<{ id: string; circleId: string }>();

  const [circleName, setCircleName] = useState('');
  const [memberCount, setMemberCount] = useState(0);
  const [post, setPost] = useState<FeedPost | null>(null);
  const [photoUri, setPhotoUri] = useState<string | undefined>();
  const [profileName, setProfileName] = useState<string | undefined>();
  const [reactions, setReactions] = useState<ReactionSummary[]>([]);
  const [comments, setComments] = useState<CommentWithAuthor[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [commentText, setCommentText] = useState('');

  const load = useCallback(async () => {
    if (!circleId || !postId) return;

    const [circle, count, feedPost, profile, reactionSummary, postComments] = await Promise.all([
      getCircleSummary(circleId),
      getCircleMemberCount(circleId),
      getFeedPost(circleId, postId),
      getProfile(),
      getReactionsForPost(circleId, postId),
      getPostComments(circleId, postId),
    ]);

    setCircleName(circle?.name ?? '');
    setMemberCount(count);
    setPost(feedPost);
    setProfileName(profile?.name);
    setReactions(reactionSummary);
    setComments(postComments);

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
  }, [circleId, postId]);

  useFocusEffect(
    useCallback(() => {
      load().catch((err) => console.error('Failed to load post details', err));
    }, [load]),
  );

  async function handleSelectReaction(emoji: string) {
    if (!circleId || !postId) return;
    await toggleReaction(circleId, postId, emoji);
    setReactions(await getReactionsForPost(circleId, postId));
    setShowPicker(false);
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
        </View>

        <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            {photoUri ? (
              <Image source={{ uri: photoUri }} style={styles.photo} contentFit="cover" />
            ) : (
              <PhotoPlaceholder style={styles.photo} />
            )}

            {post ? (
              <>
                <ThemedText type="captionDetail" style={styles.caption}>
                  {post.caption}
                </ThemedText>
                <ThemedText type="meta" themeColor="muted" style={styles.byline}>
                  {post.authorName || profileName || 'Unknown member'} · {formatTimestamp(post.createdAt)}
                </ThemedText>
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
                <ReactionPicker onSelect={handleSelectReaction} />
              </View>
            ) : null}

            <View style={styles.comments}>
              {comments.map((comment) => (
                <View key={comment.id} style={styles.commentRow}>
                  <Avatar
                    size={36}
                    uri={comment.authorPicture ? bytesToDataUri(comment.authorPicture) : undefined}
                  />
                  <View style={styles.commentBody}>
                    <ThemedText type="postAuthor">{comment.authorName || profileName || 'Unknown member'}</ThemedText>
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
              icon="arrow-up"
              size={44}
              disabled={!commentText.trim()}
              onPress={handleSubmitComment}
              style={!commentText.trim() ? styles.composerSendDisabled : undefined}
            />
          </View>
        </KeyboardAvoidingView>
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
    paddingTop: 8,
    paddingBottom: Spacing.cardListGap,
  },
  headerText: {
    flex: 1,
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
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: 6,
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
  comments: {
    gap: 14,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.cardListGap,
  },
  commentRow: {
    flexDirection: 'row',
    gap: 12,
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
