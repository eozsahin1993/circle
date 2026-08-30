import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Colors } from '@/constants/theme';

export type AvatarStackProps = {
  count: number;
  size?: number;
  max?: number;
};

/** Overlapping avatar cluster — rightmost on top, ringed in `background` to separate them. */
export function AvatarStack({ count, size = 34, max = 5 }: AvatarStackProps) {
  const shown = Math.min(count, max);

  return (
    <View style={styles.row}>
      {Array.from({ length: shown }).map((_, index) => (
        <View key={index} style={index > 0 && { marginLeft: -size * 0.3 }}>
          <Avatar size={size} ringColor={Colors.dark.background} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
});
