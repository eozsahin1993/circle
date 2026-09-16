import * as AppleAuthentication from 'expo-apple-authentication';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrivacyInfoModal } from '@/features/account/components/privacy-info-modal';
import { AppleSignInButton, GoogleSignInButton } from '@/features/account/components/social-sign-in-button';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Spacing } from '@/ui/theme/tokens';
import { getProfile } from '@/data/db';
import { hasUnreadableAccountManifest, recordSignInProviderBestEffort } from '@/features/account/usecases/account-manifest';
import { signInWithApple, signInWithGoogle } from '@/features/account/usecases/sign-in';
import { getAuthToken } from '@/core/services/keystore/auth-token';
import { goPostAuth } from '@/features/invite/services/pending-invite';

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
  const [privacyVisible, setPrivacyVisible] = useState(false);

  // Re-checked on focus, not just mount, so navigating back here post-sign-in still redirects away.
  useFocusEffect(
    useCallback(() => {
      getProfile().then((profile) => setHasProfile(profile !== null));
      getAuthToken().then((token) => setHasSession(token !== null));
    }, []),
  );

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
        await goPostAuth(router);
        return;
      }

      // Asked here and nowhere else. Every path below mints a seed, and a
      // seed is what makes the old identity unreachable — so this is the
      // last moment the answer can change anything. Best-effort: offline,
      // it asks anyway rather than minting silently, since a seed made
      // without the question is the same irreversible loss.
      const prior = await hasUnreadableAccountManifest().then(
        (found) => (found ? 'yes' : 'no'),
        () => 'unknown' as const,
      );
      if (prior !== 'no') {
        router.push({ pathname: '/account/returning', params: { certain: prior === 'yes' ? '1' : '' } });
        return;
      }

      // Always through the form, pre-filled with whatever the provider
      // gave us — profile-setup downloads the suggested picture itself.
      // Nobody gets a name and avatar committed to their circles without
      // having seen them first.
      router.push({
        pathname: '/profile-setup',
        params: {
          suggestedName: result.suggestedName ?? '',
          suggestedPictureUrl: result.suggestedPictureUrl ?? '',
          onboarding: '1',
        },
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
        `Couldn't sign in with ${providerLabel}. Try again${otherLabel ? `, or try ${otherLabel} instead` : ''}.`,
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
      <View style={styles.photo}>
        <Image source={require('@/assets/images/welcome-photo.jpg')} style={StyleSheet.absoluteFill} contentFit="cover" />
        {/* Caption sits over a real photo now, not the placeholder hatch — a
            fixed-height scrim keeps it legible regardless of what's behind it. */}
        <LinearGradient colors={['rgba(0,0,0,0.45)', 'transparent']} style={styles.photoScrim} pointerEvents="none" />
        <ThemedText
          type="eyebrow"
          style={{ paddingTop: insets.top + 8, paddingLeft: Spacing.screenPadding, color: '#fff' }}>
          Photo: the whole circle, Sunday afternoon
        </ThemedText>
      </View>

      <ThemedSafeAreaView edges={['bottom']} style={styles.content}>
        <ThemedText type="eyebrow" themeColor="accentBright">
          Hearth
        </ThemedText>
        <ThemedText type="onboardingHeadline">Private circles for your photos.</ThemedText>
        <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
          Small circles, one shared feed. End-to-end encrypted, so only your circle can ever see it.
        </ThemedText>

        <View style={styles.actions}>
          {appleAvailable ? (
            <AppleSignInButton disabled={busyProvider !== null} onPress={() => handleSignIn('apple')} />
          ) : null}
          <GoogleSignInButton disabled={busyProvider !== null} onPress={() => handleSignIn('google')} />
        </View>

        <Pressable style={styles.footer} onPress={() => setPrivacyVisible(true)}>
          <ThemedText type="meta" themeColor="muted">
            How the privacy works
          </ThemedText>
        </Pressable>
      </ThemedSafeAreaView>

      <PrivacyInfoModal visible={privacyVisible} onClose={() => setPrivacyVisible(false)} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  photo: {
    flex: 1.1,
    overflow: 'hidden',
  },
  photoScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 140,
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
