import { Image } from 'expo-image';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { StyleSheet, View } from 'react-native';

import { PhotoSlotLight } from '@/constants/theme';
import { useAppSettings } from '@/hooks/use-app-settings';
import { useTheme, useTints } from '@/hooks/use-theme';

export type AvatarProps = {
  size?: number;
  /** Border matching whatever surface it sits on, to separate overlapping avatars. */
  ringColor?: string;
  /** A real picture to show instead of the hatch placeholder — e.g. a freshly-picked profile photo. */
  uri?: string;
  /** Corner radius, defaulting to a circle. Square it off for a thumbnail of a photograph, which isn't a face. */
  radius?: number;
};

/** Shows `uri` if given, otherwise the diagonal-hatch placeholder — both clipped to a circle. */
export function Avatar({ size = 44, ringColor, uri, radius }: AvatarProps) {
  const { scheme } = useAppSettings();
  const theme = useTheme();
  const tints = useTints();
  const stripe = Math.max(6, Math.round(size / 4));
  // Dark mode's hatch sits on `surface`; light mode has no surface dim
  // enough to read as a slot, hence the dedicated PhotoSlotLight.
  const hatchFill = scheme === 'dark' ? theme.surface : PhotoSlotLight;

  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: radius ?? size / 2,
          borderWidth: ringColor ? 2 : 0,
          borderColor: ringColor,
        },
      ]}>
      {/*
        The Svg placeholder stays permanently mounted, `uri` arriving or not
        — see photo-placeholder.tsx for why an SvgView can never be
        conditionally added/removed under Fabric. `uri` usually starts null
        and flips true once an async download finishes (e.g. a Google
        sign-in profile photo), which used to swap the SvgView out for an
        Image at the same slot and crash with "already has a parent". Now
        the Image just layers on top as an extra sibling instead of
        replacing anything.
      */}
      <View style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%">
          <Defs>
            <Pattern
              id={`avatarHatch-${size}`}
              width={stripe}
              height={stripe}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)">
              <Rect width={stripe} height={stripe} fill={hatchFill} />
              <Line x1={0} y1={0} x2={0} y2={stripe} stroke={tints.chipIdleBorder} strokeWidth={1} />
            </Pattern>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#avatarHatch-${size})`} />
        </Svg>
      </View>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});
