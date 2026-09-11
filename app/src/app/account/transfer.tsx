import * as Device from 'expo-device';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { ScreenHeader } from '@/components/navbar/screen-header';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing } from '@/constants/theme';
import {
  checkDeviceTransfer,
  startDeviceTransfer,
  type PendingDeviceTransfer,
} from '@/domain/usecases/account/device-transfer';
import { useTints } from '@/hooks/use-theme';
import { showDone, showError } from '@/services/messages';

const POLL_INTERVAL_MS = 2_000;
const QR_SIZE = 220;

/**
 * The waiting device's half of a transfer: publish a one-time public key,
 * draw it, and poll until the other phone seals this account to it.
 *
 * This device shows the code rather than scanning one, which is a
 * security property rather than a layout choice — see
 * `DeviceTransferQrPayload`. What's on screen here is worthless to anyone
 * who photographs it.
 */
export default function DeviceTransferScreen() {
  const tints = useTints();
  const [pending, setPending] = useState<PendingDeviceTransfer | null>(null);
  const [failed, setFailed] = useState(false);
  // Refs, not state: the interval closes over its first render, and a
  // slow collect can still be running when the next tick fires.
  const done = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    startDeviceTransfer(Device.modelName ?? 'A new phone')
      .then((started) => !cancelled && setPending(started))
      .catch((err) => {
        console.error('Failed to start a device transfer', err);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pending) return;

    const timer = setInterval(async () => {
      if (done.current || inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await checkDeviceTransfer(pending);
        if (!result.transferred) return;

        done.current = true;
        showDone(
          result.circleCount === 1 ? 'Brought over 1 circle' : `Brought over ${result.circleCount} circles`,
        );
        router.replace('/circle');
      } catch (err) {
        console.error('Failed to complete a device transfer', err);
        done.current = true;
        showError("That transfer couldn't be completed");
        setFailed(true);
      } finally {
        inFlight.current = false;
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [pending]);

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Bring over an account" />

        <View style={styles.content}>
          <ThemedText type="captionFeed" themeColor="secondary">
            On your old phone, open Account and tap Add another device, then point it at this code.
          </ThemedText>

          <View style={[styles.qrFrame, { borderColor: tints.chipIdleBorder }]}>
            {/*
              Fixed dark-ink-on-light-plate regardless of scheme, not theme-reactive
              — the same reasoning as invite-sheet.tsx's QR: plenty of scanners
              still refuse an inverted (light-on-dark) code.
            */}
            <View style={styles.qrPlate}>
              {pending ? (
                <QRCode
                  value={JSON.stringify(pending.qr)}
                  size={QR_SIZE}
                  backgroundColor={Colors.dark.accentBright}
                  color={Colors.dark.background}
                />
              ) : (
                <ActivityIndicator color={Colors.dark.background} />
              )}
            </View>
          </View>

          {failed ? (
            <ThemedText type="meta" themeColor="muted" style={styles.status}>
              Something went wrong. Go back and try again.
            </ThemedText>
          ) : (
            <ThemedText type="meta" themeColor="muted" style={styles.status}>
              Waiting for your other phone…
            </ThemedText>
          )}

          <View style={styles.spacer} />

          <ThemedText type="meta" themeColor="faint">
            Your old phone asks you to confirm before anything is sent. Nothing on this screen is
            secret on its own.
          </ThemedText>

          <Pressable style={styles.noOtherPhone} onPress={() => router.replace('/account/restore')}>
            <ThemedText type="buttonLabel" themeColor="accentBright">
              I don&apos;t have my old phone
            </ThemedText>
          </Pressable>

          <PrimaryButton label="Cancel" onPress={() => router.back()} />
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
  qrFrame: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    width: QR_SIZE + 40,
    height: QR_SIZE + 40,
    borderRadius: Radius.panel,
    borderWidth: 1,
  },
  qrPlate: {
    padding: 14,
    borderRadius: Radius.notice,
    backgroundColor: Colors.dark.accentBright,
  },
  status: {
    textAlign: 'center',
  },
  noOtherPhone: {
    alignSelf: 'center',
    paddingVertical: 12,
  },
  spacer: {
    flex: 1,
  },
});
