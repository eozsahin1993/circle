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
  /** Unread count shown as a pill on the right — omitted entirely once there's nothing new. */
  newCount?: number;
  /** Most recent activity line, e.g. "Marcus added a photo yesterday" — falls back to the member count. */
  latestActivity?: string;
  onPress?: () => void;
};

const THUMB_SIZE = 68;

export function CircleCard({ name, memberCount, photoUri, newCount, latestActivity, onPress }: CircleCardProps) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      {photoUri ? (
        <Image source={{ uri: photoUri }} style={styles.thumb} contentFit="cover" />
      ) : (
        <PhotoPlaceholder style={styles.thumb} />
      )}

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
    gap: 14,
    paddingVertical: 12,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: Radius.panel,
  },
  body: {
    flex: 1,
    gap: 3,
  },
  badge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: Tints.chipReactedBg,
    borderWidth: 1,
    borderColor: Tints.chipReactedBorder,
  },
});
