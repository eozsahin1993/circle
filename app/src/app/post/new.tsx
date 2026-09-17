import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Switch, TextInput, View, StyleSheet } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { KeyboardAvoider } from '@/ui/components/keyboard-avoider';
import { PhotoPicker } from '@/ui/components/photo-picker';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { PhotoAspect, Radius, Spacing, Type } from '@/ui/theme/tokens';
import { getCircleSummary, getCircleMembers } from '@/data/db';
import { createPost } from '@/features/post/usecases/create-post';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { pickAndCompressImage, type CompressedImage } from '@/core/photo/image';

export default function NewPostScreen() {
  const theme = useTheme();
  const tints = useTints();
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circleName, setCircleName] = useState('');
  const [memberCount, setMemberCount] = useState(0);
  const [picture, setPicture] = useState<CompressedImage | null>(null);
  const [caption, setCaption] = useState('');
  const [addToAlbum, setAddToAlbum] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!circleId) return;
    Promise.all([getCircleSummary(circleId), getCircleMembers(circleId)]).then(([circle, members]) => {
      setCircleName(circle?.name ?? '');
      setMemberCount(members.length);
    });
  }, [circleId]);

  async function handlePickPhoto() {
    const picked = await pickAndCompressImage();
    if (picked) setPicture(picked);
  }

  async function handlePost() {
    if (!picture || !circleId) return;
    setPosting(true);
    setError(null);
    try {
      await createPost({ circleId, caption: caption.trim(), photo: picture.bytes, inAlbum: addToAlbum });
      router.back();
    } catch (err) {
      console.error('Failed to create post', err);
      setError("Couldn't post. Try again.");
      setPosting(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader variant="close" />

        <ThemedText type="screenTitle">Create a post</ThemedText>

        <View style={styles.postingToRow}>
          <ThemedText type="postAuthor">{circleName}</ThemedText>
          <ThemedText type="meta" themeColor="muted">
            {' '}
            · {memberCount} people can see it, nobody else
          </ThemedText>
        </View>

        <KeyboardAvoider style={styles.form}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <PhotoPicker
              uri={picture?.uri}
              aspectRatio={PhotoAspect.post}
              label="Tap to pick from your library"
              onPress={handlePickPhoto}
            />

            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder="Say something about this one…"
              placeholderTextColor={theme.faint}
              multiline
              style={[styles.captionInput, { color: theme.text }]}
            />

            <View style={[styles.albumRow, { backgroundColor: tints.chipIdleBg, borderColor: tints.chipIdleBorder }]}>
              <View style={styles.albumText}>
                <ThemedText type="postAuthor">Add to the album</ThemedText>
                <ThemedText type="meta" themeColor="muted">
                  Kept with the circle&rsquo;s photos · you or an admin can change this later
                </ThemedText>
              </View>
              <Switch
                value={addToAlbum}
                onValueChange={setAddToAlbum}
                trackColor={{ false: tints.chipIdleBg, true: theme.accent }}
                thumbColor={theme.text}
              />
            </View>
          </ScrollView>

          {error ? (
            <ThemedText type="captionFeed" themeColor="accent" style={styles.error}>
              {error}
            </ThemedText>
          ) : null}

          <PrimaryButton
            label={`Post to ${circleName}`}
            disabled={!picture || posting}
            onPress={handlePost}
            style={styles.postButton}
          />
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
  postingToRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 8,
    marginBottom: Spacing.cardListGap,
  },
  form: {
    flex: 1,
  },
  scrollContent: {
    gap: Spacing.cardListGap,
    paddingBottom: Spacing.cardListGap,
  },
  captionInput: {
    minHeight: 60,
    fontFamily: Type.captionDetail.fontFamily,
    fontSize: Type.captionDetail.fontSize,
    lineHeight: Type.captionDetail.lineHeight,
    textAlignVertical: 'top',
  },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderWidth: 1,
    borderRadius: Radius.notice,
    padding: Spacing.screenPadding,
  },
  albumText: {
    flex: 1,
    gap: 4,
  },
  error: {
    textAlign: 'center',
  },
  postButton: {
    marginTop: Spacing.cardListGap,
  },
});
