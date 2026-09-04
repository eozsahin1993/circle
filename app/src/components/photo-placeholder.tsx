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
      {/*
        The Svg is wrapped rather than sitting directly beside `children`.
        Under Fabric, changing siblings makes the mounting layer *move* an
        existing view rather than recreate it, and SvgView cannot be
        re-parented — it throws "addViewAt: view already has a parent" and
        corrupts the native tree, which only a full restart recovers. The
        wrapper is an ordinary ReactViewGroup, so it absorbs the move and
        the SvgView underneath is never touched.
      */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height="100%">
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
      </View>
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
