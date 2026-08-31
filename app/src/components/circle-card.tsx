import { Image } from 'expo-image';
import { Pressable, StyleSheet, View } from 'react-native';

import { PhotoPlaceholder } from '@/components/photo-placeholder';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, PhotoAspect, Radius, Spacing, Tints } from '@/constants/theme';

export type CircleCardProps = {
  name: string;
  memberCount: number;
  /** Data URI of the actual cover photo, when it's known — otherwise the hatch placeholder shows. */
  photoUri?: string;
  /** Eyebrow label over the cover photo, e.g. "PHOTO — KITCHEN TABLE, 1998". */
  photoCaption?: string;
  /** Unread count shown as a pill next to the title — omitted entirely once there's nothing new. */
  newCount?: number;
  /** Most recent activity line, e.g. "Marcus added a photo yesterday". */
  latestActivity?: string;
  onPress?: () => void;
};

export function CircleCard({
  name,
  memberCount,
  photoUri,
  photoCaption,
  newCount,
  latestActivity,
  onPress,
}: CircleCardProps) {
  return (
    <Pressable onPress={onPress}>
      <ThemedView type="surface" style={styles.card}>
        <View style={styles.photoWrap}>
          {photoUri ? (
            <Image source={{ uri: photoUri }} style={styles.photo} contentFit="cover" />
          ) : (
            <PhotoPlaceholder style={styles.photo} />
          )}
          {photoCaption ? (
            <ThemedText type="eyebrow" themeColor="faint" style={styles.photoCaption}>
              {photoCaption}
            </ThemedText>
          ) : null}
        </View>

        <View style={styles.body}>
          <View style={styles.titleRow}>
            <ThemedText type="cardTitle" style={styles.title}>
              {name}
            </ThemedText>
            {newCount ? (
              <View style={styles.badge}>
                <ThemedText type="meta" themeColor="accentBright">
                  {newCount} new
                </ThemedText>
              </View>
            ) : null}
          </View>

          <ThemedText type="meta" themeColor="muted">
            {memberCount} people · one shared feed
          </ThemedText>

          {latestActivity ? (
            <View style={styles.activityRow}>
              <View style={styles.activityDot} />
              <ThemedText type="meta" themeColor="muted">
                {latestActivity}
              </ThemedText>
            </View>
          ) : null}
        </View>
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.circleCard,
    overflow: 'hidden',
  },
  photoWrap: {
    justifyContent: 'flex-end',
  },
  photo: {
    aspectRatio: PhotoAspect.cover,
  },
  photoCaption: {
    position: 'absolute',
    left: Spacing.screenPadding,
    bottom: 16,
  },
  body: {
    padding: Spacing.screenPadding,
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.cardListGap,
  },
  title: {
    flexShrink: 1,
  },
  badge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: Tints.chipReactedBg,
    borderWidth: 1,
    borderColor: Tints.chipReactedBorder,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  activityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.dark.accent,
  },
});
