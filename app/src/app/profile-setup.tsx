import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { BackButton } from '@/components/back-button';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Fonts, Radius, Spacing, Tints } from '@/constants/theme';
import { generateSeedPhrase, seedPhraseToEntropy } from '@/lib/crypto';
import { saveProfile } from '@/lib/db';
import { pickAndCompressImage, type CompressedImage } from '@/lib/image';
import { saveMasterSeed } from '@/lib/keystore';

export default function ProfileSetupScreen() {
  const [name, setName] = useState('');
  const [picture, setPicture] = useState<CompressedImage | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleAddPicture() {
    const picked = await pickAndCompressImage();
    if (picked) setPicture(picked);
  }

  async function handleContinue() {
    setSaving(true);
    const now = Date.now();
    await saveProfile({ name: name.trim(), picture: picture?.bytes ?? null, createdAt: now, updatedAt: now });
    // Silent for now — no reveal/backup screen. Keychain-only until a
    // deliberate manual-backup design (QR or otherwise) gets built later.
    await saveMasterSeed(seedPhraseToEntropy(generateSeedPhrase()));
    router.push('/circles');
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
});
