import { Pressable, StyleSheet, Text, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Tints } from '@/constants/theme';

export type ReactionChipProps = Omit<PressableProps, 'style'> & {
  /**
   * Rendered with the platform's default font, not this app's custom
   * Figtree/Newsreader families — a custom `fontFamily` can suppress the
   * OS's automatic fallback to its color emoji font, leaving the emoji
   * blank. Keep emoji out of `label` for this reason.
   */
  emoji?: string;
  label: string;
  reacted?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A reaction chip (emoji + count) or the plain "N comments"/"+" chip — idle vs. reacted-by-me tint. */
export function ReactionChip({ emoji, label, reacted, style, ...rest }: ReactionChipProps) {
  return (
    <Pressable
      style={[styles.chip, reacted ? styles.reacted : styles.idle, style]}
      {...rest}>
      {emoji ? <Text style={styles.emoji}>{emoji}</Text> : null}
      <ThemedText type="meta" themeColor={reacted ? 'text' : 'secondary'}>
        {label}
      </ThemedText>
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
  emoji: {
    fontSize: 15,
  },
});
