import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, TextInput, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Fonts, PhotoAspect, Radius, Spacing, Tints } from '@/constants/theme';
import { getCircle, getCircleMembers } from '@/data/db';
import { createPost } from '@/domain/usecases/create-post';
import { pickAndCompressImage, type CompressedImage } from '@/services/image';

export default function NewPostScreen() {
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
    Promise.all([getCircle(circleId), getCircleMembers(circleId)]).then(([circle, members]) => {
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
      await createPost({ circleId, caption: caption.trim(), photo: picture.bytes });
      router.back();
    } catch (err) {
      console.error('Failed to create post', err);
      setError("Couldn't post — try again.");
      setPosting(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.back}>
          <Pressable hitSlop={12} onPress={() => router.back()}>
            <ThemedText type="cardTitle" themeColor="secondary">
              ✕
            </ThemedText>
          </Pressable>
        </View>

        <ThemedText type="screenTitle">Create a post</ThemedText>

        <View style={styles.postingToRow}>
          <ThemedText type="postAuthor">{circleName}</ThemedText>
          <ThemedText type="meta" themeColor="muted">
            {' '}
            · {memberCount} people can see it, nobody else
          </ThemedText>
        </View>

        <KeyboardAvoidingView style={styles.form} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <Pressable onPress={handlePickPhoto}>
              {picture ? (
                <Image source={{ uri: picture.uri }} style={styles.photo} contentFit="cover" />
              ) : (
                <PhotoPlaceholder style={styles.photo}>
                  <ThemedText type="eyebrow" style={styles.photoOverlay}>
                    Tap to pick from your library
                  </ThemedText>
                </PhotoPlaceholder>
              )}
            </Pressable>

            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder="Say something about this one…"
              placeholderTextColor={Colors.dark.faint}
              multiline
              style={styles.captionInput}
            />

            <View style={styles.albumRow}>
              <View style={styles.albumText}>
                <ThemedText type="postAuthor">Add to an album</ThemedText>
                <ThemedText type="meta" themeColor="muted">
                  Kitchen drawer scans · anyone in the circle can add
                </ThemedText>
              </View>
              <Switch
                value={addToAlbum}
                onValueChange={setAddToAlbum}
                trackColor={{ false: Tints.chipIdleBg, true: Colors.dark.accent }}
                thumbColor={Colors.dark.text}
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
  photo: {
    aspectRatio: PhotoAspect.post,
    borderRadius: Radius.panel,
    justifyContent: 'flex-end',
  },
  photoOverlay: {
    padding: Spacing.screenPadding,
  },
  captionInput: {
    minHeight: 60,
    color: Colors.dark.text,
    fontFamily: Fonts.serif,
    fontSize: 16.5,
    lineHeight: 16.5 * 1.5,
    textAlignVertical: 'top',
  },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    backgroundColor: Tints.chipIdleBg,
    borderColor: Tints.chipIdleBorder,
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
