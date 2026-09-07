import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import { getAlbumPhotos, getAttachment, getCircleSummary, type AlbumPhoto } from '@/data/db';
import { ensurePhotoUri, writePhotoFile } from '@/services/photo-cache';

/** Photos per row. Three reads as a photo library; more turns faces into thumbnails too small to recognise. */
const COLUMNS = 3;

type AlbumItem = AlbumPhoto & { uri: string };

/**
 * A week header, then that week's photos in rows of `COLUMNS`.
 *
 * A flat list of both kinds rather than `numColumns`, which can only lay
 * out uniform cells and so has nowhere to put a full-width header — same
 * discriminated-union shape the feed's own rows use.
 */
type AlbumRow =
  | { kind: 'week'; key: string; label: string }
  | { kind: 'photos'; key: string; photos: AlbumItem[] };

/** Midnight on the Sunday that starts this timestamp's week — the grouping key. */
function weekStart(ms: number): Date {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date;
}

/**
 * "Sep 1 – 7", spelling the month on both ends when the week straddles one
 * ("Aug 31 – Sep 6"), and adding the year for any week outside this one.
 */
function weekLabel(start: Date): string {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  const sameMonth = start.getMonth() === end.getMonth();
  const thisYear = start.getFullYear() === new Date().getFullYear();
  const left = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const right = end.toLocaleDateString(undefined, {
    ...(sameMonth ? {} : { month: 'short' }),
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' }),
  });
  return `${left} – ${right}`;
}

/** Groups newest-first photos into week sections, each chunked into rows. */
function buildRows(photos: AlbumItem[]): AlbumRow[] {
  const rows: AlbumRow[] = [];
  let openWeek: number | null = null;

  for (const photo of photos) {
    const start = weekStart(photo.createdAt);
    if (start.getTime() !== openWeek) {
      openWeek = start.getTime();
      rows.push({ kind: 'week', key: `week-${openWeek}`, label: weekLabel(start) });
    }

    const last = rows[rows.length - 1];
    if (last.kind === 'photos' && last.photos.length < COLUMNS) {
      last.photos.push(photo);
    } else {
      rows.push({ kind: 'photos', key: `row-${photo.id}`, photos: [photo] });
    }
  }

  return rows;
}

/**
 * Resolves each photo to a cached `file://` path, dropping any whose bytes
 * have since gone missing. Only a photo whose file isn't cached costs a
 * read of its bytes — the cache is derived, so a cleared cache directory
 * costs one rewrite rather than losing the photo (see photo-cache.ts).
 */
async function resolvePhotos(circleId: string, photos: AlbumPhoto[]): Promise<AlbumItem[]> {
  const resolved: AlbumItem[] = [];

  for (const photo of photos) {
    let uri = ensurePhotoUri(circleId, photo.id, () => null);
    if (!uri) {
      const attachment = await getAttachment(circleId, photo.id);
      if (attachment?.bytes) uri = writePhotoFile(circleId, photo.id, attachment.bytes);
    }
    if (uri) resolved.push({ ...photo, uri });
  }

  return resolved;
}

/** Every photo in this circle's album, newest week first — the archive behind the feed. */
export default function AlbumScreen() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circleName, setCircleName] = useState('');
  const [rows, setRows] = useState<AlbumRow[]>([]);
  // Avoids flashing the empty state before the first read resolves.
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!circleId) return;

    const [circle, photos] = await Promise.all([getCircleSummary(circleId), getAlbumPhotos(circleId)]);
    setCircleName(circle?.name ?? '');
    setRows(buildRows(await resolvePhotos(circleId, photos)));
    setLoaded(true);
  }, [circleId]);

  useFocusEffect(
    useCallback(() => {
      load().catch((err) => console.error('Failed to load the album', err));
    }, [load]),
  );

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ScreenHeader label={circleName ? `${circleName} album` : 'Album'} />

        <FlatList
          data={loaded ? rows : []}
          keyExtractor={(row) => row.key}
          contentContainerStyle={styles.list}
          renderItem={({ item }) =>
            item.kind === 'week' ? (
              <ThemedText type="eyebrow" themeColor="muted" style={styles.weekLabel}>
                {item.label}
              </ThemedText>
            ) : (
              <View style={styles.photoRow}>
                {item.photos.map((photo) => (
                  <Pressable
                    key={photo.id}
                    style={styles.cell}
                    onPress={() => router.push({ pathname: '/post/[id]', params: { id: photo.id, circleId } })}>
                    <Image source={{ uri: photo.uri }} style={styles.photo} contentFit="cover" />
                  </Pressable>
                ))}
                {/* Keeps a short last row left-aligned rather than stretching its photos. */}
                {Array.from({ length: COLUMNS - item.photos.length }, (_, index) => (
                  <View key={`gap-${index}`} style={styles.cell} />
                ))}
              </View>
            )
          }
          ListEmptyComponent={
            loaded ? (
              <View style={styles.empty}>
                <ThemedText type="screenTitle" style={styles.emptyText}>
                  Nothing in the album yet
                </ThemedText>
                <ThemedText type="captionFeed" themeColor="muted" style={styles.emptyText}>
                  Photos you add to the album while posting collect here, so they outlast the feed.
                </ThemedText>
              </View>
            ) : null
          }
        />
      </SafeAreaView>
    </ThemedView>
  );
}

const GAP = 3;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.topPadUnderStatusBar,
  },
  list: {
    flexGrow: 1,
    paddingBottom: Spacing.cardListGap,
  },
  weekLabel: {
    paddingTop: Spacing.cardListGap,
    paddingBottom: 8,
  },
  photoRow: {
    flexDirection: 'row',
    gap: GAP,
    marginBottom: GAP,
  },
  cell: {
    flex: 1,
    aspectRatio: 1,
  },
  photo: {
    width: '100%',
    height: '100%',
    borderRadius: Radius.notice,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.screenPadding,
    gap: Spacing.cardListGap,
  },
  emptyText: {
    textAlign: 'center',
  },
});
