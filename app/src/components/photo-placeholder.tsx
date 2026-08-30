import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { StyleSheet, View, type ViewProps } from 'react-native';

import { Colors } from '@/constants/theme';

/**
 * Stand-in for real photo content — diagonal hatch on `surface`. Every image
 * in the app is a placeholder until media upload/decrypt lands.
 */
export function PhotoPlaceholder({ style, children, ...rest }: ViewProps) {
  return (
    <View style={[styles.container, style]} {...rest}>
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <Pattern
            id="hatch"
            width={22}
            height={22}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)">
            <Rect width={22} height={22} fill={Colors.dark.surface} />
            <Line x1={0} y1={0} x2={0} y2={22} stroke="rgba(245,239,230,0.08)" strokeWidth={1} />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#hatch)" />
      </Svg>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: Colors.dark.surface,
  },
});
