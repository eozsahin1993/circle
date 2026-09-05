import { Image } from 'expo-image';
import { Pressable, StyleSheet, View } from 'react-native';

import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { ThemedText } from '@/components/themed-text';
import { Radius, Tints } from '@/constants/theme';

export type CircleCardProps = {
  name: string;
  memberCount: number;
  /** Data URI of the actual cover photo, when it's known — otherwise the hatch placeholder shows. */
  photoUri?: string;
  /** Small eyebrow caption overlaid on the thumbnail, e.g. "Photo — Lake at dusk" — see PostCard's own photoLabel. */
  photoLabel?: string;
  /** Unread count shown as a pill on the right — omitted entirely once there's nothing new. */
  newCount?: number;
  /** Most recent activity line, e.g. "Last added 6 days ago" — falls back to the member count. */
  latestActivity?: string;
  onPress?: () => void;
};

const THUMB_SIZE = 84;

export function CircleCard({ name, memberCount, photoUri, photoLabel, newCount, latestActivity, onPress }: CircleCardProps) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.thumbWrap}>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={styles.thumb} contentFit="cover" />
        ) : (
          <PhotoPlaceholder style={styles.thumb} />
        )}
        {photoLabel ? (
          <ThemedText type="eyebrow" style={styles.photoLabel} numberOfLines={3}>
            {photoLabel}
          </ThemedText>
        ) : null}
      </View>

      <View style={styles.body}>
        <ThemedText type="cardTitle" numberOfLines={1}>
          {name}
        </ThemedText>
        <ThemedText type="meta" themeColor="muted" numberOfLines={1}>
          {latestActivity ?? `${memberCount} ${memberCount === 1 ? 'person' : 'people'}`}
        </ThemedText>
      </View>

      {newCount ? (
        <View style={styles.badge}>
          <ThemedText type="meta" themeColor="accentBright">
            {newCount}
          </ThemedText>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 16,
  },
  thumbWrap: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: Radius.panel,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: Radius.panel,
  },
  photoLabel: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    right: 6,
  },
  body: {
    flex: 1,
    gap: 4,
  },
  badge: {
    minWidth: 34,
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    backgroundColor: Tints.chipReactedBg,
  },
});
