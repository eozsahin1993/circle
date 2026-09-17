import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Spacing } from '@/ui/theme/tokens';
import { abandonPriorAccount } from '@/features/account/usecases/onboarding';
import { showError } from '@/core/services/messages';

/**
 * Confirms giving up on an account this device can't read.
 *
 * Its own screen rather than an alert because of what it actually does:
 * the old manifest is the only record of which circles that identity was
 * in, and starting fresh overwrites it. A recovery phrase found in a
 * drawer next month restores the identity but not the list, so this is
 * the point of no return for a decision that otherwise looks like
 * skipping a step.
 */
export default function StartFreshScreen() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  async function handleStartFresh() {
    setBusy(true);
    try {
      await abandonPriorAccount();
      router.replace({
        pathname: '/profile-setup',
        params: { suggestedName: '', suggestedPictureUrl: '', onboarding: '1' },
      });
    } catch (err) {
      console.error('Failed to start a fresh account', err);
      showError(t('account.startFresh.failed'));
      setBusy(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('account.startFresh.header')} />

        <View style={styles.content}>
          <ThemedText type="screenTitle">{t('account.startFresh.title')}</ThemedText>
          <ThemedText type="captionFeed" themeColor="secondary">
            {t('account.startFresh.body')}
          </ThemedText>
          <ThemedText type="captionFeed" themeColor="secondary">
            {t('account.startFresh.recordNote')}
          </ThemedText>
        </View>

        <View style={styles.actions}>
          <PrimaryButton
            label={busy ? t('account.startFresh.starting') : t('account.startFresh.confirm')}
            disabled={busy}
            onPress={handleStartFresh}
          />
          <PrimaryButton label={t('account.startFresh.goBack')} disabled={busy} onPress={() => router.back()} />
        </View>
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
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.cardListGap,
  },
  actions: {
    gap: 10,
    marginBottom: 12,
  },
});
