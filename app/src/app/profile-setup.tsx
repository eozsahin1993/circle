import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { ThemedSafeAreaView } from '@/components/themed-safe-area-view';

import { Avatar } from '@/components/avatar';
import { KeyboardAvoider } from '@/components/keyboard-avoider';
import { PrimaryButton } from '@/components/primary-button';
import { ScreenHeader } from '@/components/navbar/screen-header';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { getProfile } from '@/data/db';
import { bytesToDataUri, downloadAndCompressImage, pickAndCompressImage, type CompressedImage } from '@/services/image';
import { completeProfileSetup, ensureMasterSeed } from '@/domain/usecases/account/onboarding';
import { primeOwnColorSeed } from '@/hooks/use-own-color-seed';
import { useTheme, useTints } from '@/hooks/use-theme';
import { goPostAuth } from '@/services/pending-deep-link';

export default function ProfileSetupScreen() {
  const theme = useTheme();
  const tints = useTints();
  // Only ever set by index.tsx, right after a first-time sign-in — see
  // sign-in.ts's SignInResult. Used purely as initial state below, not
  // re-read after that: this screen's own local edits always win once the
  // user starts typing/picking, and the effect further down only applies
  // suggestedPictureUrl once (empty deps), never overwriting a later
  // manual picture change.
  const { suggestedName, suggestedPictureUrl } = useLocalSearchParams<{
    suggestedName?: string;
    suggestedPictureUrl?: string;
  }>();
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
      setError("Couldn't save your profile — try again.");
      setSaving(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Your profile" />

        <KeyboardAvoider style={styles.form}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <ThemedText type="onboardingHeadline">Who are you, to the people in your circles?</ThemedText>
            <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
              A picture and a name. That is the whole profile — no username, no bio, no email, no
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

          {/* Only reachable once signed in — the transfer handshake goes
              through the relay's mailbox, which needs a session. */}
          <Pressable
            style={styles.alreadyHaveAccount}
            disabled={saving}
            onPress={() => router.push('/account/transfer')}>
            <ThemedText type="buttonLabel" themeColor="accentBright">
              I already have an account
            </ThemedText>
          </Pressable>
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
