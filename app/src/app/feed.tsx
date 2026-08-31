import { router } from 'expo-router';
import { FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CircleHeader } from '@/components/circle-header';
import { FabButton } from '@/components/fab-button';
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
  {
    id: '2',
    authorName: 'Priya',
    timestamp: 'Tuesday, 3:02pm',
    photoLabel: 'Photo — Backyard, summer 2003',
    caption: "The sprinkler that ruined every family photo for a decade. Miss that thing.",
    reactions: [
      { emoji: '😂', count: 6, reactedByMe: true },
      { emoji: '❤️', count: 2 },
    ],
    commentCount: 1,
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
          ListHeaderComponent={
            <ThemedView style={styles.header}>
              <CircleHeader name="Nana's House" memberCount={9} />
            </ThemedView>
          }
          stickyHeaderIndices={[0]}
          ItemSeparatorComponent={() => <ThemedView style={{ height: Spacing.gapBetweenPosts }} />}
          contentContainerStyle={styles.list}
        />
        <FabButton
          icon="+"
          onPress={() => router.push('/post/new')}
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
