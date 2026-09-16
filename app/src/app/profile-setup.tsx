import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { Avatar } from '@/ui/components/avatar/avatar';
import { KeyboardAvoider } from '@/ui/components/keyboard-avoider';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Fonts, Radius, Spacing } from '@/ui/theme/tokens';
import { getProfile } from '@/data/db';
import { bytesToDataUri, downloadAndCompressImage, pickAndCompressImage, type CompressedImage } from '@/core/photo/image';
import { completeProfileSetup, ensureMasterSeed } from '@/features/account/usecases/onboarding';
import { primeOwnColorSeed } from '@/ui/theme/hooks/use-own-color-seed';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { goPostAuth } from '@/features/invite/services/pending-invite';

export default function ProfileSetupScreen() {
  const theme = useTheme();
  const tints = useTints();
  // Only ever set by index.tsx, right after a first-time sign-in — see
  // sign-in.ts's SignInResult. Used purely as initial state below, not
  // re-read after that: this screen's own local edits always win once the
  // user starts typing/picking, and the effect further down only applies
  // suggestedPictureUrl once (empty deps), never overwriting a later
  // manual picture change.
  const { suggestedName, suggestedPictureUrl, onboarding } = useLocalSearchParams<{
    suggestedName?: string;
    suggestedPictureUrl?: string;
    onboarding?: string;
  }>();
  // Route params only carry strings; '1' or absent, same as `certain`
  // and `justJoined` elsewhere.
  const isOnboarding = !!onboarding;
  const [name, setName] = useState(suggestedName ?? '');
  const [picture, setPicture] = useState<CompressedImage | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [colorSeed, setColorSeed] = useState<string | undefined>(undefined);

  // A fresh install has no seed yet — created for real here rather than
  // waiting for "Continue" (see `ensureMasterSeed`'s doc comment), so the
  // avatar preview below has a stable colour to sit on immediately instead
  // of hashing the name as it's typed, letter by letter.
  useEffect(() => {
    ensureMasterSeed()
      .then((seed) => setColorSeed(primeOwnColorSeed(seed)))
      .catch((err) => console.error('Failed to ensure a master seed', err));
  }, []);

  // Reused for editing an existing profile, not just first-time setup —
  // load whatever's already saved so this doesn't look like a blank form
  // for someone who's already told us who they are.
  useEffect(() => {
    getProfile().then((profile) => {
      if (!profile) return;
      setName(profile.name);
      if (profile.picture) {
        setPicture({ uri: bytesToDataUri(profile.picture), bytes: profile.picture });
      }
    });
  }, []);

  // First-time sign-in only (see above) — fetches once, silently gives up
  // on failure (a network hiccup here shouldn't block profile setup; the
  // user can still add a picture manually either way).
  useEffect(() => {
    if (!suggestedPictureUrl) return;
    downloadAndCompressImage(suggestedPictureUrl)
      .then(setPicture)
      .catch((err) => console.error('Failed to fetch suggested profile picture', err));
  }, [suggestedPictureUrl]);

  async function handleAddPicture() {
    const picked = await pickAndCompressImage();
    if (picked) setPicture(picked);
  }

  async function handleContinue() {
    setSaving(true);
    setError(null);
    try {
      await completeProfileSetup({ name: name.trim(), picture: picture?.bytes ?? null });
      await goPostAuth(router);
    } catch (err) {
      console.error('Failed to save profile', err);
      setError("Couldn't save your profile. Try again.");
      setSaving(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        {/* Mid-onboarding, back would land on the sign-in screen (or a
            stale Welcome back after Start fresh) with a live session —
            editing from /account keeps it. */}
        <ScreenHeader title="Your profile" hideBack={isOnboarding} />

        <KeyboardAvoider style={styles.form}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <ThemedText type="onboardingHeadline">Who are you, to the people in your circles?</ThemedText>
            <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
              A picture and a name. That is the whole profile: no username, no bio, no email, no
              phone number. There is nothing else to collect.
            </ThemedText>

            <Pressable style={styles.pictureRow} onPress={handleAddPicture}>
              <Avatar size={64} uri={picture?.uri} name={name} colorSeed={colorSeed} />
              <View style={styles.pictureText}>
                <ThemedText type="cardTitle">Add a picture</ThemedText>
                <ThemedText type="meta" themeColor="muted">
                  Stays on your device and the devices of people you share circles with.
                </ThemedText>
              </View>
            </Pressable>

            <ThemedText type="eyebrow" style={styles.nameLabel}>
              Full name
            </ThemedText>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Marcus Adeyemi"
              placeholderTextColor={theme.faint}
              style={[styles.input, { color: theme.text, borderColor: tints.secondaryButtonBorder }]}
            />
          </ScrollView>

          {error ? (
            <ThemedText type="captionFeed" themeColor="accent" style={styles.error}>
              {error}
            </ThemedText>
          ) : null}

          <PrimaryButton
            label={name.trim() ? 'Continue' : 'Add your name to continue'}
            disabled={!name.trim() || saving}
            onPress={handleContinue}
            style={styles.continueButton}
          />

          {/* Onboarding only: someone editing their profile from /account
              already has this account. The transfer handshake goes through
              the relay's mailbox, which needs a session — fine here, since
              this screen is only reachable once signed in. */}
          {isOnboarding ? (
            <Pressable
              style={styles.alreadyHaveAccount}
              disabled={saving}
              onPress={() => router.push('/account/transfer')}>
              <ThemedText type="buttonLabel" themeColor="accentBright">
                I already have an account
              </ThemedText>
            </Pressable>
          ) : null}
        </KeyboardAvoider>
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
  alreadyHaveAccount: {
    alignSelf: 'center',
    marginTop: Spacing.cardListGap,
    paddingVertical: 14,
    paddingHorizontal: Spacing.screenPadding,
  },
  form: {
    flex: 1,
  },
  scrollContent: {
    gap: Spacing.cardListGap,
    paddingBottom: Spacing.cardListGap,
  },
  body: {
    marginTop: -4,
  },
  pictureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 8,
  },
  pictureText: {
    flex: 1,
    gap: 4,
  },
  nameLabel: {
    marginTop: 8,
  },
  input: {
    height: 60,
    paddingHorizontal: 20,
    borderRadius: Radius.input,
    borderWidth: 1,
    fontFamily: Fonts.serif,
    fontSize: 18,
  },
  continueButton: {
    marginTop: Spacing.cardListGap,
  },
  error: {
    textAlign: 'center',
  },
});
