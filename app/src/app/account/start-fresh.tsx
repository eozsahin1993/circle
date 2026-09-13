import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ScreenHeader } from '@/components/navbar/screen-header';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedSafeAreaView } from '@/components/themed-safe-area-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { abandonPriorAccount } from '@/domain/usecases/account/onboarding';
import { showError } from '@/services/messages';

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
  const [busy, setBusy] = useState(false);

  async function handleStartFresh() {
    setBusy(true);
    try {
      await abandonPriorAccount();
      router.replace({ pathname: '/profile-setup', params: { suggestedName: '', suggestedPictureUrl: '' } });
    } catch (err) {
      console.error('Failed to start a fresh account', err);
      showError('Could not start fresh — try again');
      setBusy(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Start fresh" />

        <View style={styles.content}>
          <ThemedText type="screenTitle">Leave the old account behind?</ThemedText>
          <ThemedText type="captionFeed" themeColor="secondary">
            You&apos;ll get a new identity on this phone. The circles you were in carry on without
            you, and the people in them keep everything you posted.
          </ThemedText>
          <ThemedText type="captionFeed" themeColor="secondary">
            This also clears the record of which circles those were. A recovery phrase found later
            still proves who you are, but it won&apos;t find them for you.
          </ThemedText>
        </View>

        <View style={styles.actions}>
          <PrimaryButton
            label={busy ? 'Starting…' : 'Start fresh'}
            disabled={busy}
            onPress={handleStartFresh}
          />
          <PrimaryButton label="Go back" disabled={busy} onPress={() => router.back()} />
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
