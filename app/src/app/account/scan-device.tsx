import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Radius, Spacing } from '@/ui/theme/tokens';
import {
  approveDeviceTransfer,
  inspectDeviceTransfer,
} from '@/features/account/usecases/device-transfer';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { showDone, showError } from '@/core/services/messages';

/**
 * The established device's half of a transfer: scan the other phone's
 * code, confirm, and seal this account to it.
 */
export default function ScanDeviceScreen() {
  const theme = useTheme();
  const tints = useTints();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);

  /**
   * Reads the code, then asks. Sealing a master seed to a key that
   * arrived through a camera is not something to do on the strength of a
   * successful scan alone, so the prompt names the device and says what
   * it is about to get.
   */
  async function handleScanned({ data }: BarcodeScanningResult) {
    if (busy) return;
    setBusy(true);
    try {
      const scanned = await inspectDeviceTransfer(data);
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
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Add another device" />

        <View style={styles.content}>
          <ThemedText type="captionFeed" themeColor="secondary">
            On your new phone, sign in and choose Bring over an existing account, then point this
            camera at the code it shows.
          </ThemedText>

          <View style={[styles.viewfinder, { backgroundColor: theme.surface, borderColor: tints.chipIdleBorder }]}>
            {permission?.granted ? (
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={busy ? undefined : handleScanned}
              />
            ) : (
              <View style={styles.permissionPrompt}>
                <ThemedText type="meta" themeColor="faint" style={styles.placeholder}>
                  {permission?.canAskAgain === false
                    ? 'Camera access is off for Circle. Turn it on in Settings to scan.'
                    : 'Circle needs your camera to scan the code.'}
                </ThemedText>
                <SecondaryButton
                  label={permission?.canAskAgain === false ? 'Open Settings' : 'Allow camera'}
                  onPress={permission?.canAskAgain === false ? Linking.openSettings : requestPermission}
                />
              </View>
            )}
          </View>

          <View style={styles.spacer} />

          <ThemedText type="meta" themeColor="faint">
            You will be asked to confirm before anything leaves this phone.
          </ThemedText>

          <PrimaryButton label="Back" disabled={busy} onPress={() => router.back()} />
        </View>
      </ThemedSafeAreaView>
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
    overflow: 'hidden',
  },
  camera: {
    flex: 1,
    width: '100%',
  },
  permissionPrompt: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.cardListGap,
    padding: Spacing.screenPadding,
  },
  placeholder: {
    textAlign: 'center',
  },
  spacer: {
    flex: 1,
  },
});
