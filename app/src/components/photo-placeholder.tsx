import { Feather } from '@expo/vector-icons';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { StyleSheet, View, type ViewProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors, Icons } from '@/constants/theme';

/**
 * Why a photo isn't here. 'arriving' is the ordinary case — the entry
 * landed before its bytes did — and says so quietly; 'unavailable' is a
 * download that has failed enough times to be worth admitting to, rather
 * than looking identical to one still on its way.
 */
export type MissingPhoto = 'arriving' | 'unavailable';

/** Maps an attachment's status to what to tell the reader. Undefined means there is nothing to explain. */
export function missingPhotoFor(status: string | null | undefined): MissingPhoto | undefined {
  if (status === 'fetched') return undefined;
  return status === 'failed' ? 'unavailable' : 'arriving';
}

const NOTES: Record<MissingPhoto, { icon: keyof typeof Feather.glyphMap; label: string }> = {
  arriving: { icon: Icons.photoArriving, label: 'Photo on its way' },
  unavailable: { icon: Icons.photoUnavailable, label: 'Photo unavailable' },
};

export type PhotoPlaceholderProps = ViewProps & {
  /** Names the gap instead of leaving the hatch to be read as either loading or broken. */
  missing?: MissingPhoto;
  /** Icon only, for a grid cell too small for a line of text. */
  compact?: boolean;
};

/**
 * Stand-in for real photo content — diagonal hatch on `surface`. Every image
 * in the app is a placeholder until media upload/decrypt lands.
 */
export function PhotoPlaceholder({ style, children, missing, compact, ...rest }: PhotoPlaceholderProps) {
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
      {missing ? (
        <View style={styles.note} pointerEvents="none">
          <Feather name={NOTES[missing].icon} size={compact ? 15 : 18} color={Colors.dark.muted} />
          {compact ? null : (
            <ThemedText type="meta" themeColor="muted">
              {NOTES[missing].label}
            </ThemedText>
          )}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: Colors.dark.surface,
  },
  // Centred over the hatch rather than in the flow, so it sits right
  // whatever shape the slot is — a 4:5 card, a square grid cell.
  note: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});
