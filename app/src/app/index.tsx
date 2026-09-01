import * as AppleAuthentication from 'expo-apple-authentication';
import { Redirect, router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { SocialSignInButton } from '@/components/social-sign-in-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getProfile } from '@/data/db';
import { signInWithApple } from '@/domain/usecases/sign-in';
import { useGoogleSignIn } from '@/hooks/use-google-sign-in';

// Required once, at module scope, so a browser-based auth session (Google)
// actually resolves its promise when the app is foregrounded again after
// the redirect — see https://docs.expo.dev/versions/v57.0.0/sdk/auth-session/.
WebBrowser.maybeCompleteAuthSession();

type Provider = 'apple' | 'google';

export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();
  // null = still checking. Runs once per launch; _layout.tsx already
  // guarantees the database is ready before this screen ever mounts.
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [busyProvider, setBusyProvider] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const google = useGoogleSignIn();

  useEffect(() => {
    getProfile().then((profile) => setHasProfile(profile !== null));
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
      const outcome = provider === 'google' ? await google.signIn() : await signInWithApple();
      if (outcome === 'success') router.push('/profile-setup');
    } catch (err) {
      console.error(`${provider} sign-in failed`, err);
      setError(err instanceof Error ? err.message : `Couldn't sign in with ${provider} — try again.`);
    } finally {
      setBusyProvider(null);
    }
  }

  if (hasProfile === null) {
    // Avoids a flash of the Welcome screen for returning users while we check.
    return <ThemedView style={styles.screen} />;
  }

  if (hasProfile) {
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
