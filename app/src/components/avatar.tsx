import { Image } from 'expo-image';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { StyleSheet, Text, View } from 'react-native';

import { AvatarInk, Fonts, PhotoSlotLight } from '@/constants/theme';
import { useAppSettings } from '@/hooks/use-app-settings';
import { useTheme, useTints } from '@/hooks/use-theme';
import { avatarTintFor, initialsOf } from '@/utils/initials';

export type AvatarProps = {
  size?: number;
  /** Border matching whatever surface it sits on, to separate overlapping avatars. */
  ringColor?: string;
  /** A real picture to show instead of the fallback — e.g. a freshly-picked profile photo. */
  uri?: string;
  /**
   * Who this is, for the initials shown when there's no picture. Pass the
   * name you display beside the avatar, so the two always agree — a
   * byline reading "Unknown member" wants those initials, not a monogram
   * implying we know whose face is missing. Absent or blank falls through
   * to the anonymous hatch.
   */
  name?: string;
  /**
   * What the initials' colour is derived from — the member's identity
   * public key. Falls back to `name`, which is all a screen showing your
   * own unsaved profile has. See avatarTintFor: never random, because a
   * colour that changed between devices would stop telling members apart,
   * which is the only reason the fallback is coloured at all.
   */
  seed?: string;
  /** Corner radius, defaulting to a circle. Square it off for a thumbnail of a photograph, which isn't a face. */
  radius?: number;
};

/**
 * A member's picture, or what stands in for it: their initials on a colour
 * derived from who they are, and failing that a neutral hatch.
 *
 * Three layers rather than three branches, and that's not a style choice —
 * see the note inside. The hatch is the bottom one throughout, so it's
 * also what shows through if either layer above has nothing to draw.
 */
export function Avatar({ size = 44, ringColor, uri, name, seed, radius }: AvatarProps) {
  const { scheme } = useAppSettings();
  const theme = useTheme();
  const tints = useTints();
  const stripe = Math.max(6, Math.round(size / 4));
  // Dark mode's hatch sits on `surface`; light mode has no surface dim
  // enough to read as a slot, hence the dedicated PhotoSlotLight.
  const hatchFill = scheme === 'dark' ? theme.surface : PhotoSlotLight;
  const initials = initialsOf(name);

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
        replacing anything. The initials layer obeys the same rule.
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
      {initials ? (
        <View style={[StyleSheet.absoluteFill, styles.initials, { backgroundColor: avatarTintFor(seed || name) }]}>
          {/*
            AvatarInk rather than `theme.text`, and unlike the hatch above
            this layer takes no scheme at all: the disc under it is one
            fixed set of tints, so a scheme-following label would go dark
            on a mid-tone fill in light mode. See AvatarTints.
            allowFontScaling off because the disc can't grow with it, and
            at 200% the letters would simply be clipped by it.
          */}
          <Text
            allowFontScaling={false}
            numberOfLines={1}
            style={[styles.initialsText, { fontSize: Math.round(size * 0.4), lineHeight: Math.round(size * 0.4 * 1.15) }]}>
            {initials}
          </Text>
        </View>
      ) : null}
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  initials: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initialsText: {
    color: AvatarInk,
    fontFamily: Fonts.sansSemiBold,
    // Tracking, because two capitals set tight read as one glyph at 34px.
    letterSpacing: 0.5,
  },
});
