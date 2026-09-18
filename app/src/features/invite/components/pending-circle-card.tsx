import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/ui/components/icon';
import { ThemedText } from '@/ui/theme/themed-text';
import { Icons, Radius } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { formatAgo } from '@/core/utils/time';
import { useLanguage } from '@/core/i18n/use-language';

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
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  const language = useLanguage();

  return (
    <Pressable
      style={[styles.card, { borderColor: tints.raisedBorder, backgroundColor: tints.chipIdleBg }]}
      onPress={onPress}>
      <Icon icon={Icons.waiting} size={22} color={theme.muted} />

      <View style={styles.body}>
        <ThemedText type="titleMedium" numberOfLines={1}>
          {circleName}
        </ThemedText>
        <ThemedText type="labelSmall" themeColor="muted">
          {createdByName
            ? t('invite.card.waitingOn', { name: createdByName, ago: formatAgo(submittedAt, language) })
            : t('invite.card.waitingOnUnknown', { ago: formatAgo(submittedAt, language) })}
        </ThemedText>
      </View>

      {onCancel ? (
        <Pressable onPress={onCancel} hitSlop={12}>
          <ThemedText type="bodyMedium" themeColor="secondary">
            {t('common.cancel')}
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
  },
  body: {
    flex: 1,
    gap: 4,
  },
});
