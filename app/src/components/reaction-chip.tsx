import { Pressable, StyleSheet, Text, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconGlyph } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Radius, Tints } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ReactionChipProps = Omit<PressableProps, 'style'> & {
  /**
   * Rendered with the platform's default font, not this app's custom
   * Figtree/Newsreader families — a custom `fontFamily` can suppress the
   * OS's automatic fallback to its color emoji font, leaving the emoji
   * blank. Keep emoji out of `label` for this reason.
   */
  emoji?: string;
  /** Leading glyph, for a chip that names an action rather than a reaction. */
  icon?: IconGlyph;
  label?: string;
  reacted?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A reaction chip (emoji + count), the React chip, or the Comment button — all one tone, so the row reads as one set of controls. */
export function ReactionChip({ emoji, icon, label, reacted, style, ...rest }: ReactionChipProps) {
  const theme = useTheme();
  const contentColor = reacted ? 'text' : 'secondary';

  return (
    <Pressable
      style={[styles.chip, reacted ? styles.reacted : styles.idle, style]}
      {...rest}>
      {icon ? <Icon icon={icon} size={15} color={theme[contentColor]} /> : null}
      {emoji ? <Text style={styles.emoji}>{emoji}</Text> : null}
      {label ? (
        // One line, ellipsized. A translated "React"/"Comment" can be far
        // longer than the English (German manages "Kommentieren"), and a
        // label that wraps would grow the chip taller than the row.
        <ThemedText type="meta" themeColor={contentColor} numberOfLines={1} style={styles.label}>
          {label}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  idle: {
    backgroundColor: Tints.chipIdleBg,
    borderColor: Tints.chipIdleBorder,
  },
  reacted: {
    backgroundColor: Tints.chipReactedBg,
    borderColor: Tints.chipReactedBorder,
  },
  label: {
    flexShrink: 1,
  },
  emoji: {
    fontSize: 15,
  },
});
