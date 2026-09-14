import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, type IconGlyph } from '@/ui/components/icon';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Icons, Radius, Spacing } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

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
              ? "Your circles are still there. This phone just can't read them yet."
              : "We couldn't reach the server to check. If you've had an account, bring it over now. Once this phone makes its own, the old one is out of reach."}
          </ThemedText>

          <View style={styles.options}>
            {/* Transfer first: it's the only one that gets you back *in*.
                The phrase restores who you are, not what you can read. */}
            <OptionCard
              icon={Icons.inviteCode}
              label="Use another device"
              description="Your old phone scans a code from this one. Restores everything."
              onPress={() => router.push('/account/transfer')}
            />
            <OptionCard
              icon={Icons.locked}
              label="Use your recovery phrase"
              description="Comes back as yourself. Someone in each circle still has to let you in."
              onPress={() => router.push('/account/restore')}
            />
          </View>
        </View>

        <Pressable style={styles.startFresh} onPress={() => router.push('/account/start-fresh')}>
          <ThemedText type="meta" themeColor="accent" style={styles.startFreshText}>
            Start fresh instead. Your previous account details will be gone.
          </ThemedText>
        </Pressable>
      </ThemedSafeAreaView>
    </ThemedView>
  );
}

type OptionCardProps = {
  icon: IconGlyph;
  label: string;
  description: string;
  onPress: () => void;
};

function OptionCard({ icon, label, description, onPress }: OptionCardProps) {
  const theme = useTheme();
  const tints = useTints();

  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <View
          style={[
            styles.option,
            { backgroundColor: tints.privacyWashBg, borderColor: tints.privacyWashBorder },
            pressed && styles.optionPressed,
          ]}>
          <Icon icon={icon} size={24} color={theme.accent} />
          <View style={styles.optionText}>
            <ThemedText type="cardTitle">{label}</ThemedText>
            <ThemedText type="meta" themeColor="muted">
              {description}
            </ThemedText>
          </View>
          <Icon icon={Icons.disclosure} size={20} color={theme.accent} />
        </View>
      )}
    </Pressable>
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
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 1,
    borderRadius: Radius.notice,
    padding: Spacing.screenPadding,
  },
  optionPressed: {
    opacity: 0.7,
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  startFresh: {
    alignSelf: 'center',
    paddingVertical: 12,
    paddingHorizontal: Spacing.screenPadding,
  },
  startFreshText: {
    textAlign: 'center',
  },
});
