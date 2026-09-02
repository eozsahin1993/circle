import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getProfile } from '@/data/db';
import { previewInvite, requestToJoin } from '@/domain/usecases/circle/join-circle';
import { getAuthToken } from '@/services/keystore';
import { savePendingInviteCode } from '@/services/pending-deep-link';

type Phase = 'checking' | 'error' | 'ready' | 'submitting';

export default function JoinInviteScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const [phase, setPhase] = useState<Phase>('checking');
  const [circleName, setCircleName] = useState('');
  const [inviterName, setInviterName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;

    (async () => {
      const [token, profile] = await Promise.all([getAuthToken(), getProfile()]);
      // Not signed in yet, or no local profile — this device has nowhere
      // authenticated to preview/request an invite from (every relay route
      // requires a session). Remember the code and send it through the
      // normal welcome/sign-in/profile-setup flow first; index.tsx picks
      // this back up once that finishes.
      if (!token || !profile) {
        await savePendingInviteCode(code);
        router.replace('/');
        return;
      }

      try {
        const preview = await previewInvite(code);
        setCircleName(preview.name);
        setInviterName(preview.createdByName);
        setPhase('ready');
      } catch (err) {
        console.error('Failed to load invite preview', err);
        setError("This invite doesn't work anymore — ask for a new one.");
        setPhase('error');
      }
    })();
  }, [code]);

  async function handleRequestToJoin() {
    if (!code) return;
    setPhase('submitting');
    try {
      const { requestId } = await requestToJoin(code);
      router.replace({ pathname: '/join/pending', params: { requestId } });
    } catch (err) {
      console.error('Failed to request to join', err);
      setError("Couldn't send your request — try again.");
      setPhase('error');
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.back}>
          <BackButton />
        </View>

        {phase === 'checking' ? null : phase === 'error' ? (
          <View style={styles.content}>
            <ThemedText type="screenTitle">Can&apos;t open this invite</ThemedText>
            <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
              {error}
            </ThemedText>
          </View>
        ) : (
          <View style={styles.content}>
            <ThemedText type="screenTitle">
              {inviterName ? `${inviterName} has invited you to` : "You're about to join"}
            </ThemedText>
            <ThemedText type="onboardingHeadline">{circleName}</ThemedText>
            <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
              {inviterName || 'Whoever shared this key'} still has to approve you before you&apos;re in.
            </ThemedText>
            <PrimaryButton
              label={phase === 'submitting' ? 'Sending request…' : 'Request to join'}
              disabled={phase === 'submitting'}
              onPress={handleRequestToJoin}
              style={styles.button}
            />
          </View>
        )}
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
  button: {
    marginTop: 8,
  },
});
