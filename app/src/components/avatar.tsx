import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { StyleSheet, View } from 'react-native';

import { Colors } from '@/constants/theme';

export type AvatarProps = {
  size?: number;
  /** Border matching whatever surface it sits on, to separate overlapping avatars. */
  ringColor?: string;
};

/** Placeholder avatar — same diagonal-hatch texture as a photo slot, clipped to a circle. */
export function Avatar({ size = 44, ringColor }: AvatarProps) {
  const stripe = Math.max(6, Math.round(size / 4));

  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: ringColor ? 2 : 0,
          borderColor: ringColor,
        },
      ]}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern
            id={`avatarHatch-${size}`}
            width={stripe}
            height={stripe}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)">
            <Rect width={stripe} height={stripe} fill={Colors.dark.surface} />
            <Line x1={0} y1={0} x2={0} y2={stripe} stroke="rgba(245,239,230,0.10)" strokeWidth={1} />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#avatarHatch-${size})`} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});
