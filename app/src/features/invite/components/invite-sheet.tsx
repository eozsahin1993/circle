import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { BottomSheet } from '@/ui/components/bottom-sheet';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ThemedText } from '@/ui/theme/themed-text';
import { Colors, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTints } from '@/ui/theme/hooks/use-theme';

export type InviteSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** What the code encodes — the deep link a scan should follow. */
  link: string;
  /** Shown under the code, for typing in by hand. */
  code: string;
  /** Already formatted, e.g. "expires in 7 days". Omitted while the invite is still being minted. */
  expiry?: string;
};

const QR_SIZE = 176;

/**
 * The invite key as something to scan, and nothing else — sharing a link
 * and replacing the key are their own actions in the section that opened
 * this, and repeating them here only makes the sheet a second, competing
 * copy of that section.
 *
 * Same slide-up mechanics as `ActionSheet`, but showing one thing rather
 * than a list of actions, so it doesn't fold into that component.
 */
export function InviteSheet({ visible, onClose, link, code, expiry }: InviteSheetProps) {
  const { t } = useTranslation();
  const tints = useTints();
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <ThemedText type="titleLarge">{t('invite.sheet.title')}</ThemedText>
        <ThemedText type="bodyMedium" themeColor="secondary" style={styles.subtitle}>
          {t('invite.sheet.subtitle')}
        </ThemedText>

        {/* Framed like the buttons that open this, but the code
                  itself stays dark-on-light: plenty of scanners still
                  refuse an inverted QR, and this one has to work on
                  whatever phone is being held up to it. */}
        <View style={[styles.qrFrame, { borderColor: tints.secondaryButtonBorder }]}>
          <View style={styles.qrPlate}>
            <QRCode
              value={link}
              size={QR_SIZE}
              color={Colors.dark.background}
              backgroundColor={Colors.dark.accentBright}
            />
          </View>
        </View>

        <ThemedText type="code" themeColor="accentBright" style={styles.code}>
          {code}
        </ThemedText>
        {expiry ? (
          <ThemedText type="labelSmall" themeColor="muted" style={styles.expiry}>
            {expiry}
          </ThemedText>
        ) : null}

        <ThemedText type="labelSmall" themeColor="faint" style={styles.footnote}>
          {t('invite.sheet.footnote')}
        </ThemedText>

        <PrimaryButton label={t('invite.done')} onPress={onClose} style={styles.done} />
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing.screenPadding,
  },
  subtitle: {
    marginTop: Space.s200,
  },
  qrFrame: {
    borderWidth: 1,
    borderRadius: Radius.panel,
    alignSelf: 'center',
    padding: Space.s400,
    marginTop: Spacing.cardListGap,
  },
  qrPlate: {
    padding: Space.s300,
    borderRadius: Radius.notice,
    backgroundColor: Colors.dark.accentBright,
  },
  code: {
    marginTop: Spacing.cardListGap,
    textAlign: 'center',
  },
  expiry: {
    marginTop: Space.s100,
    textAlign: 'center',
  },
  done: {
    marginTop: Spacing.cardListGap,
  },
  footnote: {
    marginTop: Space.s300,
    textAlign: 'center',
  },
});
