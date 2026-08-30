import { StyleSheet, View } from 'react-native';

import { Colors } from '@/constants/theme';

export type AvatarProps = {
  size?: number;
};

/** Dormant placeholder avatar — solid faintest fill, per the text ramp spec. */
export function Avatar({ size = 44 }: AvatarProps) {
  return <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]} />;
}

const styles = StyleSheet.create({
  circle: {
    backgroundColor: Colors.dark.faintest,
  },
});
