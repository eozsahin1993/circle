import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { KeyboardAvoider } from '@/ui/components/keyboard-avoider';
import { PhotoPicker } from '@/ui/components/photo-picker';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Fonts, PhotoAspect, Radius, Spacing } from '@/ui/theme/tokens';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { pickAndCompressImage, type CompressedImage } from '@/core/photo/image';

export default function NewCircleScreen() {
  const theme = useTheme();
  const tints = useTints();
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
      router.replace({ pathname: '/circle/feed', params: { circleId: circle.id } });
    } catch (err) {
      console.error('Failed to create circle', err);
      setError("Couldn't create the circle. Try again.");
      setCreating(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader variant="close" />

        <KeyboardAvoider style={styles.form}>
          <ThemedText type="screenTitle">Create circle</ThemedText>

          <View>
            <ThemedText type="sectionTitle" style={styles.fieldLabel}>
              Name
            </ThemedText>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Sunday Dinners"
              placeholderTextColor={theme.faint}
              style={[styles.input, { color: theme.text, borderColor: tints.secondaryButtonBorder }]}
            />
          </View>

          <View>
            <ThemedText type="sectionTitle" style={styles.fieldLabel}>
              Cover
            </ThemedText>
            <PhotoPicker
              uri={cover?.uri}
              aspectRatio={PhotoAspect.cover}
              label="Tap to choose a photo"
              onPress={handlePickCover}
            />
          </View>

          {error ? (
            <ThemedText type="captionFeed" themeColor="accent" style={styles.error}>
              {error}
            </ThemedText>
          ) : null}

          <PrimaryButton label="Create circle" disabled={!name.trim() || creating} onPress={handleCreate} />

          <ThemedText type="meta" themeColor="faint" style={styles.footnote}>
            Only the people you invite can see this circle, and everyone sees the same feed in
            the same order.
          </ThemedText>
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
  form: {
    flex: 1,
    gap: Spacing.cardListGap,
  },
  input: {
    height: 60,
    paddingHorizontal: 20,
    borderRadius: Radius.input,
    borderWidth: 1,
    fontFamily: Fonts.sans,
    fontSize: 18,
  },
  fieldLabel: {
    marginBottom: 10,
  },
  footnote: {
    textAlign: 'center',
  },
  error: {
    textAlign: 'center',
  },
});
