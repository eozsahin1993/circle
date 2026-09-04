import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';

import { BackButton } from '@/components/back-button';
import { PendingJoinRequestCard } from '@/components/pending-join-request-card';
import { PrimaryButton } from '@/components/primary-button';
import { SecondaryButton } from '@/components/secondary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { getCircleSummary } from '@/data/db';
import {
  approveJoinRequest,
  denyJoinRequest,
  discoverPendingRequests,
  getOrCreateInvite,
  replaceInvite,
  type PendingRequest,
} from '@/domain/usecases/circle/invite-to-circle';
import type { Invite } from '@/data/db';

function inviteLink(code: string): string {
  return `circle://join/${code}`;
}

function formatExpiry(expiresAt: number): string {
  const days = Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'expired';
  return days === 1 ? 'expires in 1 day' : `expires in ${days} days`;
}

export default function CircleInviteScreen() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circleName, setCircleName] = useState('');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [actioningId, setActioningId] = useState<string | null>(null);

  useEffect(() => {
    if (!circleId) return;
    getCircleSummary(circleId).then((circle) => setCircleName(circle?.name ?? ''));
    getOrCreateInvite(circleId)
      .then(setInvite)
      .catch((err) => {
        console.error('Failed to create invite', err);
        setError("Couldn't create an invite for this circle.");
      });
  }, [circleId]);

  // Re-checked on every focus, not just mount — a request may have arrived
  // while this screen wasn't open. Only ever populates for this invite's
  // actual creator (see `discoverPendingRequests`'s creator-only gate) —
  // for anyone else, including a fellow admin, this section simply stays
  // empty rather than showing an error.
  useFocusEffect(
    useCallback(() => {
      if (!circleId) return;
      discoverPendingRequests(circleId)
        .then(setPendingRequests)
        .catch(() => setPendingRequests([]));
    }, [circleId]),
  );

  async function handleApprove(requesterId: string) {
    if (!circleId) return;
    setActioningId(requesterId);
    try {
      await approveJoinRequest(circleId, requesterId);
      setPendingRequests((current) => current.filter((request) => request.requesterId !== requesterId));
    } catch (err) {
      console.error('Failed to approve join request', err);
      Alert.alert("Couldn't let them in", 'Try again in a moment.');
    } finally {
      setActioningId(null);
    }
  }

  async function handleDeny(requesterId: string) {
    if (!circleId) return;
    setActioningId(requesterId);
    try {
      await denyJoinRequest(circleId, requesterId);
      setPendingRequests((current) => current.filter((request) => request.requesterId !== requesterId));
    } catch (err) {
      console.error('Failed to dismiss join request', err);
      Alert.alert("Couldn't dismiss that request", 'Try again in a moment.');
    } finally {
      setActioningId(null);
    }
  }

  async function handleShare() {
    if (!invite) return;
    await Share.share({ message: `Join ${circleName} on Circle: ${inviteLink(invite.code)}` });
  }

  async function handleReplace() {
    if (!circleId) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await replaceInvite(circleId);
      setInvite(fresh);
      setShowKey(false);
    } catch (err) {
      console.error('Failed to replace invite', err);
      setError("Couldn't replace the key — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.back}>
          <BackButton label="Invite" />
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <ThemedText type="screenTitle">Invite to {circleName}</ThemedText>
          <ThemedText type="captionFeed" themeColor="secondary" style={styles.body}>
            Nobody can find this circle. The only way in is this key — hand it over in person, or
            send the link somewhere you trust.
          </ThemedText>

          {invite ? (
            <>
              <View style={styles.qrRow}>
                <View style={styles.qrWrap}>
                  <QRCode
                    value={inviteLink(invite.code)}
                    size={110}
                    color={Colors.dark.background}
                    backgroundColor={Colors.dark.accentBright}
                  />
                </View>
                <View style={styles.qrText}>
                  <ThemedText type="eyebrow" themeColor="muted">
                    Show this, or share the link
                  </ThemedText>
                  <ThemedText type="meta" themeColor="muted" style={styles.expiry}>
                    {formatExpiry(invite.expiresAt)}
                  </ThemedText>
                  <Pressable onPress={() => setShowKey((v) => !v)}>
                    <ThemedText type="meta" themeColor="accentBright" style={styles.showKey}>
                      {showKey ? 'Hide key' : 'Or enter this code manually'}
                    </ThemedText>
                  </Pressable>
                  {showKey ? (
                    <ThemedText type="inviteKey" style={styles.key}>
                      {invite.code}
                    </ThemedText>
                  ) : null}
                </View>
              </View>

              {error ? (
                <ThemedText type="captionFeed" themeColor="accent" style={styles.error}>
                  {error}
                </ThemedText>
              ) : null}

              <PrimaryButton label="Share the link" onPress={handleShare} style={styles.shareButton} />
              <SecondaryButton label="Replace key" disabled={busy} onPress={handleReplace} />

              <ThemedText type="meta" themeColor="faint" style={styles.footnote}>
                Replacing the key stops anyone who still has the old one. People already in the
                circle stay in.
              </ThemedText>
            </>
          ) : null}

          {pendingRequests.length > 0 ? (
            <View style={styles.requestsSection}>
              {pendingRequests.map((request) => (
                <PendingJoinRequestCard
                  key={request.requesterId}
                  request={request}
                  busy={actioningId !== null}
                  onApprove={() => handleApprove(request.requesterId)}
                  onDeny={() => handleDeny(request.requesterId)}
                />
              ))}
            </View>
          ) : null}
        </ScrollView>
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
  scroll: {
    flex: 1,
  },
  content: {
    gap: Spacing.cardListGap,
    paddingBottom: Spacing.cardListGap,
  },
  body: {
    marginTop: -8,
  },
  qrRow: {
    flexDirection: 'row',
    gap: 16,
  },
  qrWrap: {
    padding: 12,
    borderRadius: Radius.panel,
    backgroundColor: Colors.dark.accentBright,
  },
  qrText: {
    flex: 1,
    gap: 6,
    justifyContent: 'center',
  },
  expiry: {
    marginTop: -2,
  },
  showKey: {
    marginTop: 4,
  },
  key: {
    marginTop: 4,
  },
  error: {
    textAlign: 'center',
  },
  shareButton: {
    marginTop: 4,
  },
  footnote: {
    textAlign: 'center',
  },
  requestsSection: {
    marginTop: Spacing.cardListGap,
    gap: 12,
  },
});
