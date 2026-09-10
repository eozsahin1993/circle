import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Icons, Radius, Tints } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatRelativeTime } from '@/services/relative-time';

export type PendingCircleCardProps = {
  circleName: string;
  /** The invite creator's self-reported name — blank until the preview decodes, so the copy falls back. */
  createdByName: string;
  /** When this device submitted the request, for the "asked …" half of the line. */
  submittedAt: number;
  onPress?: () => void;
  onCancel?: () => void;
};

/**
 * A circle asked for but not yet joined.
 *
 * Dashed rather than solid, and no cover photo: there is nothing of the
 * circle to show yet, and the outline says the row is a placeholder for
 * one rather than a circle that failed to load. Cancel sits on the row
 * itself because withdrawing is the only other thing you can do here, and
 * burying it behind a tap would make waiting feel like the only option.
 */
export function PendingCircleCard({ circleName, createdByName, submittedAt, onPress, onCancel }: PendingCircleCardProps) {
  const theme = useTheme();

  return (
    <Pressable style={[styles.card, { borderColor: Tints.raisedBorder }]} onPress={onPress}>
      <Icon icon={Icons.waiting} size={22} color={theme.muted} />

      <View style={styles.body}>
        <ThemedText type="cardTitle" numberOfLines={1}>
          {circleName}
        </ThemedText>
        <ThemedText type="meta" themeColor="muted">
          {createdByName ? `Waiting on ${createdByName} to approve you` : 'Waiting on whoever sent the key'} · asked{' '}
          {formatRelativeTime(submittedAt)}
        </ThemedText>
      </View>

      {onCancel ? (
        <Pressable onPress={onCancel} hitSlop={12}>
          <ThemedText type="captionFeed" themeColor="secondary">
            Cancel
          </ThemedText>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 18,
    borderRadius: Radius.panel,
    borderWidth: 1,
    borderStyle: 'dashed',
    backgroundColor: Tints.chipIdleBg,
  },
  body: {
    flex: 1,
    gap: 4,
  },
});
