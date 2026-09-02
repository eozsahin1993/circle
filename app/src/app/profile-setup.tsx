import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { BackButton } from '@/components/back-button';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Fonts, Radius, Spacing, Tints } from '@/constants/theme';
import { getProfile } from '@/data/db';
import { bytesToDataUri, downloadAndCompressImage, pickAndCompressImage, type CompressedImage } from '@/services/image';
import { completeProfileSetup } from '@/domain/usecases/onboarding';

export default function ProfileSetupScreen() {
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
      router.push('/circle');
    } catch (err) {
      console.error('Failed to save profile', err);
      setError("Couldn't save your profile — try again.");
      setSaving(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.back}>
          <BackButton />
        </View>

        <KeyboardAvoidingView style={styles.form} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <ThemedText type="onboardingHeadline">Who are you, to the people in your circles?</ThemedText>
            <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
              A picture and a name. That is the whole profile — no username, no bio, no email, no
              phone number. There is nothing else to collect.
            </ThemedText>

            <Pressable style={styles.pictureRow} onPress={handleAddPicture}>
              <Avatar size={64} uri={picture?.uri} />
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
              placeholderTextColor={Colors.dark.faint}
              style={styles.input}
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
        </KeyboardAvoidingView>
      </SafeAreaView>
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
    paddingTop: Spacing.topPadUnderStatusBar,
  },
  back: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    marginBottom: Spacing.cardListGap,
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
    borderColor: Tints.secondaryButtonBorder,
    color: Colors.dark.text,
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
