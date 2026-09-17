import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { SettingsGroups, type SettingsGroup } from '@/ui/components/settings-group';
import { ThemedView } from '@/ui/theme/themed-view';
import { Spacing } from '@/ui/theme/tokens';

export default function CreditsScreen() {
  const { t } = useTranslation();

  const creditsGroups: SettingsGroup[] = [
    {
      title: t('account.credits.photos'),
      rows: [
        {
          label: t('account.credits.welcomePhoto'),
          description: t('account.credits.welcomePhotoCredit', { author: 'Simi Iluyomade' }),
        },
      ],
    },
  ];

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('settings.credits')} />

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <SettingsGroups groups={creditsGroups} />
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
