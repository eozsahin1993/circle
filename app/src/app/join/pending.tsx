import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getPendingJoinRequest } from '@/data/db';
import { checkPendingJoinRequest } from '@/domain/usecases/circle/join-circle';

export default function JoinPendingScreen() {
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const [circleName, setCircleName] = useState('');
  const [inviterName, setInviterName] = useState('');
  const [gone, setGone] = useState(false);

  // Re-checked on every focus (app foreground, returning to this screen)
  // rather than a timer — same app-lifecycle-triggered polling as the
  // rest of this flow, never dependent on push (see
  // server/INVITE_FLOW.md's goals). Also survives the app being closed
  // and reopened entirely: `pendingJoinRequests` is the local source for
  // `circleName` below, not component state carried from the previous screen.
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

      checkPendingJoinRequest(requestId)
        .then((result) => {
          if (result.joined) {
            router.replace({ pathname: '/feed', params: { circleId: result.circleId, justJoined: '1' } });
          }
        })
        .catch((err) => console.error('Failed to check pending join request', err));
    }, [requestId]),
  );

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.back}>
          <BackButton />
        </View>

        <View style={styles.content}>
          {gone ? (
            <>
              <ThemedText type="screenTitle">Request no longer available</ThemedText>
              <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
                This might mean it already went through on another device.
              </ThemedText>
            </>
          ) : (
            <>
              <ThemedText type="screenTitle">Waiting for approval</ThemedText>
              <ThemedText type="onboardingHeadline">{circleName}</ThemedText>
              <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
                {inviterName || 'Whoever shared this key'} needs to let you in. Come back to this
                screen once they have — or just reopen the app.
              </ThemedText>
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
    paddingTop: Spacing.topPadUnderStatusBar,
  },
  back: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    marginBottom: Spacing.cardListGap,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.cardListGap,
  },
  body: {
    marginTop: -8,
  },
});
