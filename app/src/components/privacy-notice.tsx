import { Pressable, StyleSheet } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Colors, Icons, Spacing } from '@/constants/theme';

export type PrivacyNoticeProps = {
  /** Opens the privacy explainer sheet — what end-to-end encrypted means here. */
  onPress?: () => void;
};

/** Quiet, easy-to-ignore reminder that scrolls with the feed — not part of the pinned nav header. */
export function PrivacyNotice({ onPress }: PrivacyNoticeProps) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Icon icon={Icons.locked} size={12} color={Colors.dark.accent} />
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
