import { Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Tints } from '@/constants/theme';

export type ReactionChipProps = Omit<PressableProps, 'style'> & {
  label: string;
  reacted?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A reaction chip (emoji + count) or the plain "N comments" chip — idle vs. reacted-by-me tint. */
export function ReactionChip({ label, reacted, style, ...rest }: ReactionChipProps) {
  return (
    <Pressable
      style={[styles.chip, reacted ? styles.reacted : styles.idle, style]}
      {...rest}>
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
});
