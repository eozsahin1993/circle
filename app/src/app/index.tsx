import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';

export default function CircleListScreen() {
  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="eyebrow" style={styles.eyebrow}>
          Hearth
        </ThemedText>
        <ThemedText type="circleListHeader">Circles</ThemedText>

        <ThemedView type="surface" style={styles.emptyState}>
          <ThemedText type="cardTitle">No circles yet</ThemedText>
          <ThemedText type="captionFeed" themeColor="secondary">
            A circle is a private group — only the people you invite can see what&apos;s shared
            inside it.
          </ThemedText>
        </ThemedView>

        <PrimaryButton label="New circle" style={styles.pinnedButton} />
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
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.topPadUnderStatusBar,
    gap: Spacing.cardListGap,
  },
  eyebrow: {
    marginBottom: 2,
  },
  emptyState: {
    borderRadius: Radius.circleCard,
    padding: Spacing.screenPadding,
    gap: 8,
  },
  pinnedButton: {
    position: 'absolute',
    left: Spacing.screenPadding,
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    elevation: 10,
  },
});
