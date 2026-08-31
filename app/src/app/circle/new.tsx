import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Fonts, PhotoAspect, Radius, Spacing, Tints } from '@/constants/theme';
import { createCircle } from '@/domain/usecases/create-circle';
import { pickAndCompressImage, type CompressedImage } from '@/services/image';

export default function NewCircleScreen() {
  const [name, setName] = useState('');
  const [cover, setCover] = useState<CompressedImage | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePickCover() {
    const picked = await pickAndCompressImage();
    if (picked) setCover(picked);
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const circle = await createCircle({ name: name.trim(), picture: cover?.bytes });
      router.replace({ pathname: '/feed', params: { circleId: circle.id } });
    } catch (err) {
      console.error('Failed to create circle', err);
      setError("Couldn't create the circle — try again.");
      setCreating(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.back}>
          <BackButton />
        </View>

        <KeyboardAvoidingView
          style={styles.form}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ThemedText type="screenTitle">Name your circle</ThemedText>

          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. The Andersons"
            placeholderTextColor={Colors.dark.faint}
            style={styles.input}
          />

          <View>
            <ThemedText type="eyebrow" style={styles.coverLabel}>
              Cover
            </ThemedText>
            <Pressable onPress={handlePickCover}>
              {cover ? (
                <Image source={{ uri: cover.uri }} style={styles.cover} contentFit="cover" />
              ) : (
                <PhotoPlaceholder style={styles.cover}>
                  <ThemedText type="eyebrow" style={styles.coverOverlay}>
                    Tap to choose a photo
                  </ThemedText>
                </PhotoPlaceholder>
              )}
            </Pressable>
          </View>

          <ThemedView style={styles.notice}>
            <ThemedText type="captionFeed" themeColor="accent">
              Only the people you invite can see this circle. Everyone in it sees the same feed,
              in the same order. Nothing is ranked, and nothing is ever auto-deleted.
            </ThemedText>
            <ThemedText type="captionFeed" themeColor="accentBright" style={styles.noticeLink}>
              How the privacy works →
            </ThemedText>
          </ThemedView>

          {error ? (
            <ThemedText type="captionFeed" themeColor="accent" style={styles.error}>
              {error}
            </ThemedText>
          ) : null}

          <PrimaryButton
            label="Create and invite people"
            disabled={!name.trim() || creating}
            onPress={handleCreate}
          />

          <ThemedText type="meta" themeColor="faint" style={styles.footnote}>
            Who can invite, and what happens to the photos over time, is in the circle&apos;s
            settings later.
          </ThemedText>
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
    gap: Spacing.cardListGap,
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
  coverLabel: {
    marginBottom: 10,
  },
  cover: {
    aspectRatio: PhotoAspect.cover,
    borderRadius: Radius.panel,
    justifyContent: 'flex-end',
  },
  coverOverlay: {
    padding: Spacing.screenPadding,
  },
  notice: {
    backgroundColor: Tints.privacyWashBg,
    borderColor: Tints.privacyWashBorder,
    borderWidth: 1,
    borderRadius: Radius.notice,
    padding: Spacing.screenPadding,
    gap: 12,
  },
  noticeLink: {
    fontFamily: Fonts.sansMedium,
  },
  footnote: {
    textAlign: 'center',
  },
  error: {
    textAlign: 'center',
  },
});
