import { ScrollView, StyleSheet } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { SettingsGroups, type SettingsGroup } from '@/ui/components/settings-group';
import { ThemedView } from '@/ui/theme/themed-view';
import { Spacing } from '@/ui/theme/tokens';

const CREDITS_GROUPS: SettingsGroup[] = [
  {
    title: 'Photos',
    rows: [
      {
        label: 'Welcome photo',
        description: 'Simi Iluyomade on Unsplash',
      },
    ],
  },
];

export default function CreditsScreen() {
  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Credits & attribution" />

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <SettingsGroups groups={CREDITS_GROUPS} />
        </ScrollView>
      </ThemedSafeAreaView>
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
  },
  content: {
    paddingBottom: Spacing.cardListGap * 2,
  },
});
