import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { type CommentItem, PostComments } from '@/components/post-comments';
import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { ReactionChip } from '@/components/reaction-chip';
import { ReactionPicker } from '@/components/reaction-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { PhotoAspect, Spacing } from '@/constants/theme';

export type Reaction = {
  emoji: string;
  count: number;
  reactedByMe?: boolean;
};

export type Post = {
  id: string;
  authorName: string;
  /** Data URI of the author's profile picture, when it's known — otherwise the hatch placeholder shows. */
  authorPhotoUri?: string;
  timestamp: string;
  /** Data URI of the actual photo, when it's known — otherwise the hatch placeholder shows. */
  photoUri?: string;
  photoLabel?: string;
  caption: string;
  reactions: Reaction[];
  comments: CommentItem[];
};

export type PostCardProps = {
  post: Post;
  onToggleReaction?: (emoji: string) => void;
  onAddComment?: (body: string) => void;
};

export function PostCard({ post, onToggleReaction, onAddComment }: PostCardProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [showComments, setShowComments] = useState(false);

  function handleSelect(emoji: string) {
    onToggleReaction?.(emoji);
    setShowPicker(false);
  }

  return (
    <ThemedView style={styles.card}>
      <View style={styles.header}>
        <Avatar uri={post.authorPhotoUri} />
        <View>
          <ThemedText type="postAuthor">{post.authorName}</ThemedText>
          <ThemedText type="meta" themeColor="muted">
            {post.timestamp}
          </ThemedText>
        </View>
      </View>

      <View style={styles.photoWrap}>
        {post.photoUri ? (
          <Image source={{ uri: post.photoUri }} style={styles.photo} contentFit="cover" />
        ) : (
          <PhotoPlaceholder style={styles.photo} />
        )}
        {post.photoLabel ? (
          <ThemedText type="eyebrow" style={styles.photoLabel}>
            {post.photoLabel}
          </ThemedText>
        ) : null}
      </View>

      <ThemedText type="captionFeed" style={styles.caption}>
        {post.caption}
      </ThemedText>

      <View style={styles.reactions}>
        {post.reactions.map((reaction) => (
          <ReactionChip
            key={reaction.emoji}
            emoji={reaction.emoji}
            label={String(reaction.count)}
            reacted={reaction.reactedByMe}
            onPress={() => onToggleReaction?.(reaction.emoji)}
          />
        ))}
        <ReactionChip label="+" onPress={() => setShowPicker((v) => !v)} />
        <ReactionChip
          label={`${post.comments.length} comment${post.comments.length === 1 ? '' : 's'}`}
          onPress={() => setShowComments((v) => !v)}
        />
      </View>

      {showPicker ? (
        <View style={styles.picker}>
          <ReactionPicker onSelect={handleSelect} />
        </View>
      ) : null}

      {showComments ? (
        <View style={styles.comments}>
          <PostComments comments={post.comments} onSubmit={(body) => onAddComment?.(body)} />
        </View>
      ) : null}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.screenPadding,
    paddingVertical: 14,
  },
  photoWrap: {
    justifyContent: 'flex-end',
  },
  photo: {
    aspectRatio: PhotoAspect.post,
  },
  photoLabel: {
    position: 'absolute',
    left: Spacing.screenPadding,
    bottom: 16,
  },
  caption: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: 14,
  },
  reactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: 12,
    paddingBottom: 4,
  },
  picker: {
    paddingHorizontal: Spacing.screenPadding,
    paddingBottom: 12,
  },
  comments: {
    paddingHorizontal: Spacing.screenPadding,
    paddingBottom: 12,
  },
});
