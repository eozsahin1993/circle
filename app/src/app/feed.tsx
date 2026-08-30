import { FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PostCard, type Post } from '@/components/post-card';
import { Spacing } from '@/constants/theme';
import { ThemedView } from '@/components/themed-view';

const POSTS: Post[] = [
  {
    id: '1',
    authorName: 'Marcus',
    timestamp: 'Yesterday, 7:14pm',
    photoLabel: 'Photo — Kitchen table, 1998',
    caption: "Nana in the kitchen she refused to remodel. Found this in the drawer with the batteries.",
    reactions: [
      { emoji: '❤️', count: 9, reactedByMe: true },
      { emoji: '🥺', count: 4 },
      { emoji: '🙏', count: 3 },
    ],
    commentCount: 3,
  },
];

export default function FeedScreen() {
  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <FlatList
          data={POSTS}
          keyExtractor={(post) => post.id}
          renderItem={({ item }) => <PostCard post={item} />}
          ItemSeparatorComponent={() => <ThemedView style={{ height: Spacing.gapBetweenPosts }} />}
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
});
