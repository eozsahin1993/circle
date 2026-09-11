import { Pressable, StyleSheet } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Icons, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type PrivacyNoticeProps = {
  /** Opens the privacy explainer sheet — what end-to-end encrypted means here. */
  onPress?: () => void;
};

/** Quiet, easy-to-ignore reminder that scrolls with the feed — not part of the pinned nav header. */
export function PrivacyNotice({ onPress }: PrivacyNoticeProps) {
  const theme = useTheme();

  return (
    <Pressable style={styles.row} onPress={onPress}>
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
