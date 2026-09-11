import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Icons, Radius, Tints, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type CommentItem = {
  id: string;
  authorName: string;
  /** Data URI of the author's picture, when known — otherwise their initials show. */
  authorPhotoUri?: string;
  /** The author's identity key, which fixes the colour their initials sit on — see Avatar's `seed`. */
  authorKey?: string;
  body: string;
  /** Relative and short — "3d", "6h" — since the post's own timestamp already gives the absolute anchor. */
  timestamp: string;
};

export type PostCommentsProps = {
  /** The newest comment, the only one a card shows. */
  latest?: CommentItem;
  /** How many there are in all — the "Show all" link appears past one. */
  total: number;
  /** Revealed by the card's Comment button — a quiet post shows the chip row and nothing more. */
  composerOpen: boolean;
  onSubmit: (body: string) => void;
  /** Opens the post's own screen, where the whole thread lives. */
  onPressShowAll?: () => void;
  /** The reader's own picture — shown beside the composer and the empty-state invitation, both of which are addressed to them. */
  selfPhotoUri?: string;
  /** The reader's own name and key, for the composer avatar's initials before they've set a picture. */
  selfName?: string;
  selfKey?: string;
};

const AVATAR_SIZE = 30;

/**
 * Shorter than a primary button — this sits inside a feed card next to
 * 14pt comment text, not at the bottom of a form, so it's sized to the
 * line it holds. The send button matches it exactly so the two read as
 * one control.
 */
const COMPOSER_HEIGHT = 42;

/**
 * The comment area under a feed post: the most recent comment, a way
 * into the rest, and the composer once the card's Comment button has
 * asked for it.
 *
 * Only ever one comment shown. A feed row is a photograph with a little context
 * under it, not a thread — the whole thread is one tap away on the post's
 * own screen, which is also the only place it can scroll independently of
 * the feed. The summary line is that tap.
 */
export function PostComments({
  latest,
  total,
  composerOpen,
  onSubmit,
  onPressShowAll,
  selfPhotoUri,
  selfName,
  selfKey,
}: PostCommentsProps) {
  const theme = useTheme();
  const [text, setText] = useState('');

  function handleSubmit() {
    if (!text.trim()) return;
    onSubmit(text);
    setText('');
  }

  return (
    <View style={styles.container}>
      {latest ? (
        <View style={styles.commentRow}>
          <Avatar size={AVATAR_SIZE} uri={latest.authorPhotoUri} name={latest.authorName} seed={latest.authorKey} />
          <View style={styles.commentBody}>
            <ThemedText type="comment" themeColor="secondary">
              <ThemedText type="postAuthor">{latest.authorName}</ThemedText>
              {'  '}
              {latest.body}
            </ThemedText>
            <ThemedText type="meta" themeColor="faint">
              {latest.timestamp}
            </ThemedText>
          </View>
        </View>
      ) : null}

      {total > 1 ? (
        <Pressable style={styles.showAll} onPress={onPressShowAll} disabled={!onPressShowAll} hitSlop={6}>
          <ThemedText type="comment" themeColor="secondary">
            Show all {total} comments
          </ThemedText>
        </Pressable>
      ) : null}

      {composerOpen ? (
        <View style={styles.composer}>
          {/* Full composer height, unlike the comment rows' smaller
              avatar — here it's one of three controls on a line, and a
              short circle beside a tall box reads as misaligned however
              it's centred. */}
          <Avatar size={COMPOSER_HEIGHT} uri={selfPhotoUri} name={selfName} seed={selfKey} />
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={handleSubmit}
            placeholder="Add a comment"
            placeholderTextColor={theme.muted}
            returnKeyType="send"
            autoFocus
            multiline
            style={[styles.input, { color: theme.text }]}
          />
          {/* Appears only once there's something to send, so an untouched
              composer is just the field. */}
          {text.trim() ? (
            <Pressable onPress={handleSubmit} style={[styles.send, { backgroundColor: theme.accent }]}>
              <Icon icon={Icons.send} size={17} color={theme.accentLabel} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Its own rhythm, tighter than the card's bands: comment, link and
    // composer are one group, not three.
    gap: 12,
  },
  commentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  commentBody: {
    flex: 1,
    gap: 2,
  },
  showAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  composer: {
    flexDirection: 'row',
    // Centred, not bottom-aligned: the avatar is shorter than the box, so
    // flex-end left it hanging off the bottom edge rather than reading as
    // one row.
    alignItems: 'center',
    gap: 10,
  },
  input: {
    flex: 1,
    minHeight: COMPOSER_HEIGHT,
    maxHeight: COMPOSER_HEIGHT * 3,
    paddingHorizontal: 16,
    // Centres a single line the way `height` would, without stopping the
    // field growing once the text wraps.
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Tints.chipIdleBorder,
    backgroundColor: Tints.chipIdleBg,
    // Matches the comment rows above it — what you type should look like
    // what it becomes. `lineHeight` is left off deliberately: on a
    // multiline TextInput it throws the vertical centring out on Android.
    fontFamily: Type.comment.fontFamily,
    fontSize: Type.comment.fontSize,
  },
  send: {
    width: COMPOSER_HEIGHT,
    height: COMPOSER_HEIGHT,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
