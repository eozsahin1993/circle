import { ScrollView, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { BottomSheet } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Spacing, Tints } from '@/constants/theme';

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
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <ThemedText type="screenTitle">Let them scan it</ThemedText>
        <ThemedText type="captionFeed" themeColor="secondary" style={styles.subtitle}>
          Best when the person is next to you, so the key never leaves the room.
        </ThemedText>

        {/* Framed like the buttons that open this, but the code
                  itself stays dark-on-light: plenty of scanners still
                  refuse an inverted QR, and this one has to work on
                  whatever phone is being held up to it. */}
        <View style={styles.qrFrame}>
          <View style={styles.qrPlate}>
            <QRCode
              value={link}
              size={QR_SIZE}
              color={Colors.dark.background}
              backgroundColor={Colors.dark.accentBright}
            />
          </View>
        </View>

        <ThemedText type="inviteKey" themeColor="accentBright" style={styles.code}>
          {code}
        </ThemedText>
        {expiry ? (
          <ThemedText type="meta" themeColor="muted" style={styles.expiry}>
            {expiry}
          </ThemedText>
        ) : null}

        <ThemedText type="meta" themeColor="faint" style={styles.footnote}>
          Everyone shares this code until you replace it.
        </ThemedText>

        <PrimaryButton label="Done" onPress={onClose} style={styles.done} />
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing.screenPadding,
  },
  subtitle: {
    marginTop: 6,
  },
  qrFrame: {
    borderWidth: 1,
    borderColor: Tints.secondaryButtonBorder,
    borderRadius: Radius.panel,
    alignSelf: 'center',
    padding: 14,
    marginTop: Spacing.cardListGap,
  },
  qrPlate: {
    padding: 12,
    borderRadius: Radius.notice,
    backgroundColor: Colors.dark.accentBright,
  },
  code: {
    marginTop: Spacing.cardListGap,
    textAlign: 'center',
  },
  expiry: {
    marginTop: 4,
    textAlign: 'center',
  },
  done: {
    marginTop: Spacing.cardListGap,
  },
  footnote: {
    marginTop: 10,
    textAlign: 'center',
  },
});
