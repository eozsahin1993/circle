import * as AppleAuthentication from 'expo-apple-authentication';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { SocialSignInButton } from '@/components/social-sign-in-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getProfile } from '@/data/db';
import { signInWithApple, signInWithGoogle } from '@/domain/usecases/sign-in';
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
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    setBusyProvider(provider);
    try {
      const outcome = provider === 'google' ? await signInWithGoogle() : await signInWithApple();
      // A returning device (local profile already exists — e.g. this was
      // just a re-auth after signing out) has nothing new to fill in;
      // only a genuinely first-time sign-in needs profile-setup.
      if (outcome === 'success') router.push(hasProfile ? '/circle' : '/profile-setup');
    } catch (err) {
      console.error(`${provider} sign-in failed`, err);
      setError(err instanceof Error ? err.message : `Couldn't sign in with ${provider} — try again.`);
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
          {error ? (
            <ThemedText type="captionFeed" themeColor="accent" style={styles.error}>
              {error}
            </ThemedText>
          ) : null}
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
  error: {
    textAlign: 'center',
  },
  footer: {
    alignSelf: 'center',
    paddingVertical: 8,
  },
});
