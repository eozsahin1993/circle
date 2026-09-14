import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Icons, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type PrivacyNoticeProps = {
  /** Opens the privacy explainer sheet — what end-to-end encrypted means here. */
  onPress?: () => void;
  /**
   * Overrides the row's own horizontal padding — the feed's list has none
   * of its own, but a screen whose container already insets its content
   * (the circle list) would otherwise double it up.
   */
  style?: StyleProp<ViewStyle>;
};

/** Quiet, easy-to-ignore reminder that scrolls with its list, wherever that list is. */
export function PrivacyNotice({ onPress, style }: PrivacyNoticeProps) {
  const theme = useTheme();

  return (
    <Pressable style={[styles.row, style]} onPress={onPress}>
      {/* Matches the "Tap for privacy details" label's own accentBright, so the icon and the label it sits beside read as one color. */}
      <Icon icon={Icons.locked} size={12} color={theme.accentBright} />
      <ThemedText type="meta" style={styles.text}>
        <ThemedText type="meta" themeColor="muted">
          End-to-end encrypted.{' '}
        </ThemedText>
        <ThemedText type="meta" themeColor="accentBright">
          Tap for privacy details
        </ThemedText>
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: Spacing.feedTextPadding,
    paddingVertical: 4,
  },
  text: {
    flex: 1,
  },
});
