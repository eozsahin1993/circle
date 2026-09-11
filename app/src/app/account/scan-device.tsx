import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { ScreenHeader } from '@/components/navbar/screen-header';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import {
  approveDeviceTransfer,
  inspectDeviceTransfer,
} from '@/domain/usecases/account/device-transfer';
import { useTheme, useTints } from '@/hooks/use-theme';
import { showDone, showError } from '@/services/messages';

/**
 * The established device's half of a transfer: scan the other phone's
 * code, confirm, and seal this account to it.
 *
 * The camera is not wired yet — `expo-camera` is a native dependency and
 * needs a rebuild. Everything downstream of a scanned string is finished
 * and tested, so landing it is a matter of calling `handleScanned` from
 * the barcode callback and replacing the placeholder below.
 */
export default function ScanDeviceScreen() {
  const theme = useTheme();
  const tints = useTints();
  const [busy, setBusy] = useState(false);

  /**
   * Reads the code, then asks. Sealing a master seed to a key that
   * arrived through a camera is not something to do on the strength of a
   * successful scan alone, so the prompt names the device and says what
   * it is about to get.
   */
  // Unused only until the camera lands — this is the callback the barcode
  // scanner calls, kept whole so wiring it is one line rather than a rewrite.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function handleScanned(raw: string) {
    if (busy) return;
    setBusy(true);
    try {
      const scanned = await inspectDeviceTransfer(raw);
      Alert.alert(
        `Add ${scanned.deviceName}?`,
        `It will hold the same keys as this phone and see all ${
          scanned.circleCount === 1 ? 'your circle' : `${scanned.circleCount} of your circles`
        }. You cannot take that back later.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => setBusy(false) },
          {
            text: 'Add device',
            onPress: async () => {
              try {
                await approveDeviceTransfer(scanned.qr);
                showDone('Sent to your other phone');
                router.back();
              } catch (err) {
                console.error('Failed to approve a device transfer', err);
                showError("That device couldn't be added");
              } finally {
                setBusy(false);
              }
            },
          },
        ],
      );
    } catch (err) {
      console.error('Failed to read a transfer code', err);
      showError(err instanceof Error ? err.message : "That code couldn't be read");
      setBusy(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Add another device" />

        <View style={styles.content}>
          <ThemedText type="captionFeed" themeColor="secondary">
            On your new phone, sign in and choose Bring over an existing account, then point this
            camera at the code it shows.
          </ThemedText>

          <View style={[styles.viewfinder, { backgroundColor: theme.surface, borderColor: tints.chipIdleBorder }]}>
            <ThemedText type="meta" themeColor="faint" style={styles.placeholder}>
              The camera needs a new build of the app before this can scan.
            </ThemedText>
          </View>

          <View style={styles.spacer} />

          <ThemedText type="meta" themeColor="faint">
            You will be asked to confirm before anything leaves this phone.
          </ThemedText>

          <PrimaryButton label="Back" disabled={busy} onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.screenPadding,
  },
  content: {
    flex: 1,
    gap: Spacing.cardListGap,
  },
  viewfinder: {
    alignItems: 'center',
    justifyContent: 'center',
    aspectRatio: 1,
    borderRadius: Radius.panel,
    borderWidth: 1,
    padding: Spacing.screenPadding,
  },
  placeholder: {
    textAlign: 'center',
  },
  spacer: {
    flex: 1,
  },
});
