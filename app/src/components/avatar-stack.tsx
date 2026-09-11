import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

export type AvatarStackProps = {
  count: number;
  size?: number;
  max?: number;
};

/**
 * Overlapping avatar cluster — rightmost on top, ringed in `background` to
 * separate them. Past `max`, the last slot becomes a "+N" chip instead of
 * silently dropping members — otherwise a circle of 5 and a circle of 50
 * render identically.
 *
 * Deliberately the anonymous placeholder rather than initials: this takes a
 * count, not a roster, so there's nobody in particular in any given slot.
 */
export function AvatarStack({ count, size = 34, max = 5 }: AvatarStackProps) {
  const theme = useTheme();
  const overflow = count > max;
  const avatarCount = overflow ? max - 1 : count;
  const hiddenCount = count - avatarCount;
  const overlap = -size * 0.3;

  return (
    <View style={styles.row}>
      {Array.from({ length: avatarCount }).map((_, index) => (
        <View key={index} style={index > 0 && { marginLeft: overlap }}>
          <Avatar size={size} ringColor={theme.background} />
        </View>
      ))}
      {overflow && (
        <View
          style={[
            styles.overflow,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              marginLeft: avatarCount > 0 ? overlap : 0,
              borderColor: theme.background,
              backgroundColor: theme.surface,
            },
          ]}>
          <ThemedText type="meta" themeColor="text">
            +{hiddenCount}
          </ThemedText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
  overflow: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
});
