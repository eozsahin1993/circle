import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  TransferCodeError,
} from '@/features/account/usecases/device-transfer';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { showDone, showError } from '@/core/services/messages';

/**
 * The established device's half of a transfer: scan the other phone's
 * code, confirm, and seal this account to it.
 */
export default function ScanDeviceScreen() {
  const { t } = useTranslation();
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
        scanned.deviceName
          ? t('account.scanDevice.confirmTitle', { name: scanned.deviceName })
          : t('account.scanDevice.confirmTitleUnnamed'),
        t('account.scanDevice.confirmMessage', { count: scanned.circleCount }),
        [
          { text: t('common.cancel'), style: 'cancel', onPress: () => setBusy(false) },
          {
            text: t('account.scanDevice.addDevice'),
            onPress: async () => {
              try {
                await approveDeviceTransfer(scanned.qr);
                showDone(t('account.scanDevice.sent'));
                router.back();
              } catch (err) {
                console.error('Failed to approve a device transfer', err);
                showError(t('account.scanDevice.addFailed'));
              } finally {
                setBusy(false);
              }
            },
          },
        ],
      );
    } catch (err) {
      console.error('Failed to read a transfer code', err);
      showError(
        err instanceof TransferCodeError
          ? t(err.reason === 'invalid' ? 'account.scanDevice.invalidCode' : 'account.scanDevice.expiredCode')
          : t('account.scanDevice.unreadableCode'),
      );
      setBusy(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('account.scanDevice.header')} />

        <View style={styles.content}>
          <ThemedText type="captionFeed" themeColor="secondary">
            {t('account.scanDevice.instructions')}
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
                    ? t('account.scanDevice.cameraOff')
                    : t('account.scanDevice.cameraNeeded')}
                </ThemedText>
                <SecondaryButton
                  label={
                    permission?.canAskAgain === false
                      ? t('account.scanDevice.openSettings')
                      : t('account.scanDevice.allowCamera')
                  }
                  onPress={permission?.canAskAgain === false ? Linking.openSettings : requestPermission}
                />
              </View>
            )}
          </View>

          <View style={styles.spacer} />

          <ThemedText type="meta" themeColor="faint">
            {t('account.scanDevice.confirmNote')}
          </ThemedText>

          <PrimaryButton label={t('account.scanDevice.back')} disabled={busy} onPress={() => router.back()} />
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
