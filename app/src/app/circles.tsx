import { router } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CircleCard } from '@/components/circle-card';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export default function CircleListScreen() {
  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="eyebrow" style={styles.eyebrow}>
          Hearth
        </ThemedText>
        <ThemedText type="circleListHeader">Circles</ThemedText>

        <CircleCard name="Nana's House" memberCount={9} onPress={() => router.push('/feed')} />

        <PrimaryButton
          label="New circle"
          onPress={() => router.push('/circle/new')}
          style={styles.pinnedButton}
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
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.topPadUnderStatusBar,
    gap: Spacing.cardListGap,
  },
  eyebrow: {
    marginBottom: 2,
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
