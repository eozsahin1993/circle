import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Tints } from '@/constants/theme';

export type CommentItem = {
  id: string;
  authorName: string;
  body: string;
};

export type PostCommentsProps = {
  comments: CommentItem[];
  onSubmit: (body: string) => void;
};

/** How many of the most recent comments show by default before "View all" — keeps a busy post from ballooning the feed row. */
const PREVIEW_COUNT = 3;

export function PostComments({ comments, onSubmit }: PostCommentsProps) {
  const [text, setText] = useState('');
  const [showAll, setShowAll] = useState(false);

  const hasMore = comments.length > PREVIEW_COUNT;
  const visibleComments = showAll ? comments : comments.slice(-PREVIEW_COUNT);

  function handleSubmit() {
    if (!text.trim()) return;
    onSubmit(text);
    setText('');
  }

  return (
    <View style={styles.container}>
      {hasMore && !showAll ? (
        <Pressable onPress={() => setShowAll(true)}>
          <ThemedText type="meta" themeColor="accentBright">
            View all {comments.length} comments
          </ThemedText>
        </Pressable>
      ) : null}

      {visibleComments.map((comment) => (
        <View key={comment.id} style={styles.row}>
          <ThemedText type="postAuthor">{comment.authorName} </ThemedText>
          <ThemedText type="comment" themeColor="secondary">
            {comment.body}
          </ThemedText>
        </View>
      ))}

      <View style={styles.inputRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={handleSubmit}
          placeholder="Add a comment…"
          placeholderTextColor={Colors.dark.faint}
          returnKeyType="send"
          style={styles.input}
        />
        <Pressable hitSlop={8} onPress={handleSubmit} disabled={!text.trim()}>
          <ThemedText type="buttonLabel" themeColor={text.trim() ? 'accentBright' : 'faint'}>
            Post
          </ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  input: {
    flex: 1,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Tints.chipIdleBorder,
    backgroundColor: Tints.chipIdleBg,
    color: Colors.dark.text,
    fontSize: 14,
  },
});
