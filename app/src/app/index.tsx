import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { PrimaryButton } from '@/components/primary-button';
import { SecondaryButton } from '@/components/secondary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();

  return (
    <ThemedView style={styles.screen}>
      <PhotoPlaceholder style={styles.photo}>
        <ThemedText type="eyebrow" style={{ paddingTop: insets.top + 8, paddingLeft: Spacing.screenPadding }}>
          Photo — Grandmother&apos;s kitchen, 1994
        </ThemedText>
      </PhotoPlaceholder>

      <SafeAreaView edges={['bottom']} style={styles.content}>
        <ThemedText type="eyebrow" themeColor="accentBright">
          Hearth
        </ThemedText>
        <ThemedText type="onboardingHeadline">Keep the pictures where the people are.</ThemedText>
        <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
          Small circles. One shared feed. Photos live on the phones of the people in the circle —
          not on a company&apos;s servers.
        </ThemedText>

        <View style={styles.actions}>
          <PrimaryButton label="Set up a profile" onPress={() => router.push('/profile-setup')} />
          <SecondaryButton label="I already have an account" onPress={() => router.push('/circles')} />
        </View>

        <Pressable style={styles.footer}>
          <ThemedText type="meta" themeColor="muted">
            How the privacy works
          </ThemedText>
        </Pressable>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  photo: {
    flex: 1.1,
  },
  content: {
    flex: 1,
    paddingHorizontal: Spacing.screenPadding,
    justifyContent: 'center',
    gap: Spacing.cardListGap,
  },
  body: {
    marginTop: -4,
  },
  actions: {
    gap: 12,
    marginTop: 8,
  },
  footer: {
    alignSelf: 'center',
    paddingVertical: 8,
  },
});
