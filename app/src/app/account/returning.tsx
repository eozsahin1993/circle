import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { ScreenHeader } from '@/components/navbar/screen-header';
import { PrimaryButton } from '@/components/primary-button';
import { SettingsGroups, type SettingsGroup } from '@/components/settings-group';
import { ThemedSafeAreaView } from '@/components/themed-safe-area-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

/**
 * Offered when signing in finds a manifest this device can't read — you've
 * used Circle on this account before, from a phone whose seed this one
 * doesn't have.
 *
 * Deliberately vague about what's there. The manifest is encrypted under
 * the old seed and the relay stores nothing in the clear beside it, so
 * "your circles" is the most that can honestly be said — no count, no
 * names. Inventing either would mean asking the relay to hold metadata
 * the whole design keeps it from having.
 *
 * Shown before onboarding mints a seed, because that is the last moment
 * the answer changes anything. After it, the old identity is unreachable
 * and every manifest write fails as a `ForeignManifestError` nobody chose.
 */
export default function ReturningAccountScreen() {
  // Unset when the check couldn't reach the relay. Asking anyway beats
  // minting a seed in silence, but it mustn't claim to know something it
  // doesn't — a first-time user offline would be told they'd been here.
  const { certain } = useLocalSearchParams<{ certain?: string }>();

  const groups: SettingsGroup[] = [
    {
      title: 'Get back in',
      rows: [
        // Transfer first: it's the only one that gets you back *in*. The
        // phrase restores who you are, not what you can read.
        {
          label: 'Bring them from another device',
          description: 'Your old phone scans a code from this one. Restores everything.',
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/transfer'),
        },
        {
          label: 'Use your recovery phrase',
          description: 'Comes back as yourself — someone in each circle still has to let you in.',
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/restore'),
        },
      ],
    },
  ];

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Welcome back" />

        <View style={styles.content}>
          <ThemedText type="screenTitle">
            {certain ? "You've used Circle before" : 'Used Circle before?'}
          </ThemedText>
          <ThemedText type="captionFeed" themeColor="secondary">
            {certain
              ? "Your circles are still there — this phone just can't read them yet."
              : "We couldn't reach the server to check. If you've had an account, bring it over now — once this phone makes its own, the old one is out of reach."}
          </ThemedText>

          <View style={styles.options}>
            <SettingsGroups groups={groups} />
          </View>
        </View>

        <PrimaryButton
          label="Start fresh instead"
          onPress={() => router.push('/account/start-fresh')}
          style={styles.startFresh}
        />
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
  options: {
    gap: 12,
    marginTop: 8,
  },
  startFresh: {
    marginBottom: 12,
  },
});
