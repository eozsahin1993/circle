import * as AppleAuthentication from 'expo-apple-authentication';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { SocialSignInButton } from '@/components/social-sign-in-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getProfile } from '@/data/db';
import { recordSignInProviderBestEffort } from '@/domain/usecases/account-manifest';
import { completeProfileSetup } from '@/domain/usecases/onboarding';
import { signInWithApple, signInWithGoogle } from '@/domain/usecases/sign-in';
import { downloadAndCompressImage } from '@/services/image';
import { getAuthToken } from '@/services/keystore';

type Provider = 'apple' | 'google';

export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();
  // null = still checking. Runs once per launch; _layout.tsx already
  // guarantees the database is ready before this screen ever mounts.
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);
  // Local profile data and the relay session are deliberately independent
  // (see sign-in.ts's signOut doc comment) — skipping straight to /circle
  // needs *both*, not just a local profile. Signing out clears the
  // session but not local data, so without this check a signed-out
  // returning user would get redirected straight past this screen and
  // never see the sign-in buttons at all.
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [busyProvider, setBusyProvider] = useState<Provider | null>(null);

  useEffect(() => {
    getProfile().then((profile) => setHasProfile(profile !== null));
  }, []);

  useEffect(() => {
    getAuthToken().then((token) => setHasSession(token !== null));
  }, []);

  useEffect(() => {
    // Sign in with Apple only exists as a concept on Apple's own
    // platforms — no equivalent to fall back to elsewhere, so the button
    // just doesn't render rather than showing something that always fails.
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  async function handleSignIn(provider: Provider) {
    setBusyProvider(provider);
    try {
      const result = provider === 'google' ? await signInWithGoogle() : await signInWithApple();
      if (result.outcome !== 'success') return;

      // Best-effort — silently a no-op on a brand-new install's very
      // first sign-in (no master seed yet), picked up on the next one.
      recordSignInProviderBestEffort(provider);

      // A returning device (local profile already exists — e.g. this was
      // just a re-auth after signing out) has nothing new to fill in.
      if (hasProfile) {
        router.push('/circle');
        return;
      }

      // Only skip profile-setup entirely when the provider gave us a
      // *complete* profile — name and picture both. Apple never provides
      // a picture at all, so this never applies to it; Google usually
      // does, but a failed download falls through to the form below
      // rather than silently leaving someone with no picture and no
      // chance to add one.
      if (result.suggestedName && result.suggestedPictureUrl) {
        try {
          const { bytes } = await downloadAndCompressImage(result.suggestedPictureUrl);
          await completeProfileSetup({ name: result.suggestedName, picture: bytes });
          router.push('/circle');
          return;
        } catch (err) {
          console.error('Failed to auto-complete profile from sign-in', err);
          // fall through to the pre-filled manual form below
        }
      }

      router.push({
        pathname: '/profile-setup',
        params: { suggestedName: result.suggestedName ?? '', suggestedPictureUrl: result.suggestedPictureUrl ?? '' },
      });
    } catch (err) {
      console.error(`${provider} sign-in failed`, err);
      const providerLabel = provider === 'apple' ? 'Apple' : 'Google';
      // Only suggest the other provider if it's actually on offer — Apple
      // isn't available at all on this device (see appleAvailable above),
      // so telling an Android user to "try Apple instead" would be wrong.
      const otherLabel = provider === 'apple' ? 'Google' : appleAvailable ? 'Apple' : null;
      Alert.alert(
        'Sign-in failed',
        `Couldn't sign in with ${providerLabel} — try again${otherLabel ? `, or try ${otherLabel} instead` : ''}.`,
      );
    } finally {
      setBusyProvider(null);
    }
  }

  if (hasProfile === null || hasSession === null) {
    // Avoids a flash of the Welcome screen for returning users while we check.
    return <ThemedView style={styles.screen} />;
  }

  if (hasProfile && hasSession) {
    return <Redirect href="/circle" />;
  }

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
          {appleAvailable ? (
            <SocialSignInButton
              provider="apple"
              disabled={busyProvider !== null}
              onPress={() => handleSignIn('apple')}
            />
          ) : null}
          <SocialSignInButton
            provider="google"
            disabled={busyProvider !== null}
            onPress={() => handleSignIn('google')}
          />
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
