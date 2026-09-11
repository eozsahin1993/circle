import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/navbar/screen-header';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getPendingJoinRequest } from '@/data/db';
import { cancelPendingJoinRequest, checkPendingJoinRequest } from '@/domain/usecases/circle/join-circle';

/**
 * Faster than the sync scheduler's 30s: this is someone watching a screen
 * for one specific answer, not background housekeeping.
 */
const CHECK_INTERVAL_MS = 5_000;

export default function JoinPendingScreen() {
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const [circleName, setCircleName] = useState('');
  const [inviterName, setInviterName] = useState('');
  const [gone, setGone] = useState(false);

  // Polled while this screen is up, not only on focus. Focus alone meant
  // the one screen whose entire job is waiting never noticed the thing it
  // was waiting for: staying put fires nothing, and returning from the
  // background fires nothing either, since navigation focus was never
  // lost. Approval arrived and the screen kept saying "waiting" until you
  // navigated away and back.
  //
  // Never dependent on push arriving — approval must complete even if
  // notifications are disabled or the platform never delivers one. Also
  // survives the app being closed and reopened entirely:
  // `pendingJoinRequests` is the local source for `circleName` below, not
  // component state carried from the previous screen.
  useFocusEffect(
    useCallback(() => {
      if (!requestId) return;

      getPendingJoinRequest(requestId).then((pending) => {
        if (!pending) {
          setGone(true);
          return;
        }
        setCircleName(pending.circleName);
        setInviterName(pending.createdByName);
      });

      let stopped = false;
      const check = () => {
        if (stopped) return;
        checkPendingJoinRequest(requestId)
          .then((result) => {
            if (stopped) return;
            if (result.joined) {
              stopped = true;
              router.replace({ pathname: '/circle/feed', params: { circleId: result.circleId, justJoined: '1' } });
              return;
            }
            // Denied, or aged out. Nothing will ever answer it, so say so
            // rather than leaving this screen waiting indefinitely.
            if ('gone' in result) {
              stopped = true;
              setGone(true);
            }
          })
          .catch((err) => console.error('Failed to check pending join request', err));
      };

      check();
      const interval = setInterval(check, CHECK_INTERVAL_MS);
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') check();
      });

      return () => {
        stopped = true;
        clearInterval(interval);
        subscription.remove();
      };
    }, [requestId]),
  );

  function handleCancel() {
    if (!requestId) return;
    Alert.alert('Withdraw this request?', 'You can ask again with a new key.', [
      { text: 'Keep waiting', style: 'cancel' },
      {
        text: 'Withdraw',
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelPendingJoinRequest(requestId);
          } catch (err) {
            console.error('Failed to withdraw join request', err);
          }
          router.dismissTo('/circle');
        },
      },
    ]);
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Join request" />

        <View style={styles.content}>
          {gone ? (
            <>
              <ThemedText type="screenTitle">Request no longer available</ThemedText>
              <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
                It may have gone through on another device, or whoever shared the key turned it
                down.
              </ThemedText>
            </>
          ) : (
            <>
              <ThemedText type="screenTitle">Waiting for approval</ThemedText>
              <ThemedText type="onboardingHeadline">{circleName}</ThemedText>
              <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
                {inviterName || 'Whoever shared this key'} needs to let you in. This screen moves on
                by itself once they have.
              </ThemedText>

              <Pressable onPress={handleCancel} style={styles.cancel}>
                <ThemedText type="captionFeed" themeColor="danger">
                  Withdraw request
                </ThemedText>
              </Pressable>
            </>
          )}
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
    justifyContent: 'center',
    gap: Spacing.cardListGap,
  },
  body: {
    marginTop: -8,
  },
  cancel: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
  },
});
