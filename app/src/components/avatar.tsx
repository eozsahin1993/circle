import { Image } from 'expo-image';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { StyleSheet, View } from 'react-native';

import { Colors } from '@/constants/theme';

export type AvatarProps = {
  size?: number;
  /** Border matching whatever surface it sits on, to separate overlapping avatars. */
  ringColor?: string;
  /** A real picture to show instead of the hatch placeholder — e.g. a freshly-picked profile photo. */
  uri?: string;
};

/** Shows `uri` if given, otherwise the diagonal-hatch placeholder — both clipped to a circle. */
export function Avatar({ size = 44, ringColor, uri }: AvatarProps) {
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
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} />
      ) : (
        // Wrapped so the node Fabric moves is a plain view, never the
        // SvgView — see photo-placeholder.tsx for why that matters.
        <View style={StyleSheet.absoluteFill}>
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
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});
