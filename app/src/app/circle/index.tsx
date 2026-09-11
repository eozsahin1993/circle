import { bytesToHex } from '@noble/curves/utils.js';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { CircleCard } from '@/components/circle-card';
import { JoinSheet } from '@/components/join-sheet';
import { PendingCircleCard } from '@/components/pending-circle-card';
import { EmptyCirclesIcon } from '@/components/empty-circles-icon';
import { FabButton } from '@/components/fab-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Icons, Spacing } from '@/constants/theme';
import {
  getAllPendingJoinRequests,
  getCircleMemberCount,
  getNewestPostCreatedAt,
  getProfile,
  getUnreadCount,
  listCircles,
  type CircleListRow,
} from '@/data/db';
import type { PendingJoinRequest } from '@/data/db/pending-join-requests';
import { resolveCircleCoverUri } from '@/domain/usecases/circle/circle-cover';
import { cancelPendingJoinRequest, checkPendingJoinRequest } from '@/domain/usecases/circle/join-circle';
import { takePendingInviteCode } from '@/services/pending-deep-link';
import { getCircleIdentity } from '@/services/keystore';
import { bytesToDataUri } from '@/services/image';
import { formatRelativeTime } from '@/services/relative-time';
import { nudgePhotoQueue } from '@/sync/photo-queue';
import { showError } from '@/services/messages';
import { syncAllCircles } from '@/sync/sync-circles';

type CircleListItem = CircleListRow & {
  memberCount: number;
  photoUri?: string;
  newCount: number;
  latestActivity?: string;
};

/**
 * The unread badge's count — 0 (not shown at all) whenever this device has
 * no circle identity yet, which briefly happens between joining and that
 * join actually completing. No badge is the honest state there, not an
 * error to surface.
 */
async function resolveUnreadCount(circle: CircleListRow): Promise<number> {
  const identity = await getCircleIdentity(circle.id);
  if (!identity) return 0;
  return getUnreadCount(circle.id, bytesToHex(identity.publicKey), circle.createdAt, circle.lastViewedAt);
}

/** "Last added just now" / "…3 hours ago" / "…6 days ago" — undefined for a circle with no posts yet. */
async function resolveLatestActivity(circleId: string): Promise<string | undefined> {
  const newestPostCreatedAt = await getNewestPostCreatedAt(circleId);
  return newestPostCreatedAt === null ? undefined : `Last added ${formatRelativeTime(newestPostCreatedAt)}`;
}

export default function CircleListScreen() {
  const [avatarUri, setAvatarUri] = useState<string | undefined>();
  // Only for the header avatar's initials until a picture is set — the
  // name itself isn't shown on this screen.
  const [profileName, setProfileName] = useState<string | undefined>();
  const [circles, setCircles] = useState<CircleListItem[]>([]);
  // Avoids flashing the empty state before the first load resolves.
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Circles asked for but not yet let into — shown above the real ones so
  // a request isn't invisible until you happen to reopen /join/pending.
  const [pending, setPending] = useState<PendingJoinRequest[]>([]);
  // The invite code a link handed over, if any — the join sheet opens over
  // this screen rather than being a route of its own.
  const [joinCode, setJoinCode] = useState<string | null>(null);

  /** Re-reads the circle list from the local database. No network. */
  const loadFromDatabase = useCallback(async () => {
    const profile = await getProfile();
    setAvatarUri(profile?.picture ? bytesToDataUri(profile.picture) : undefined);
    setProfileName(profile?.name);

    // listCircles rather than getAllCircles: the latter is select(), so it
    // drags every circle's cover blob into JS on each focus. See circles.ts.
    const allCircles = await listCircles();
    const withCounts = await Promise.all(
      allCircles.map(async (circle) => {
        const [memberCount, photoUri, newCount, latestActivity] = await Promise.all([
          getCircleMemberCount(circle.id),
          resolveCircleCoverUri(circle.id),
          resolveUnreadCount(circle),
          resolveLatestActivity(circle.id),
        ]);
        return { ...circle, memberCount, photoUri, newCount, latestActivity };
      }),
    );
    setCircles(withCounts);
    setLoaded(true);
  }, []);

  /**
   * Completes any join whose approval has landed, reporting whether one
   * did. Callers reload on true: the circle a join produces is written
   * after this screen has already read the list, so without it the new
   * circle doesn't show until something else triggers a read.
   */
  const completePendingJoins = useCallback(async () => {
    const requests = await getAllPendingJoinRequests();
    setPending(requests);
    const results = await Promise.all(
      requests.map((request) =>
        checkPendingJoinRequest(request.id).catch((err) => {
          console.error('Failed to check a pending join request', err);
          return { joined: false };
        }),
      ),
    );
    // Re-read rather than filtering locally: completing a join deletes the
    // row, and a request that was denied or aged out is gone too.
    if (results.some((result) => result.joined || 'gone' in result)) {
      setPending(await getAllPendingJoinRequests());
    }
    return results.some((result) => result.joined);
  }, []);

  // On mount as well as on focus. A screen underneath a modal never gains
  // focus, so opening an invite link — which puts this screen up and a
  // sheet straight over it — would otherwise leave the list behind the
  // sheet empty, header and all, with circles sitting unread in SQLite.
  useEffect(() => {
    // Disabled rather than restructured: the state this sets lands in a
    // promise callback a query later, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFromDatabase().catch((err) => console.error('Failed to load circles', err));
    takePendingInviteCode()
      .then((code) => code && setJoinCode(code))
      .catch((err) => console.error('Failed to read a pending invite code', err));
  }, [loadFromDatabase]);

  // Re-check on every focus, not just mount — picture/circles may have just
  // changed on a screen this one returns to (profile, new circle, a post).
  useFocusEffect(
    useCallback(() => {
      loadFromDatabase().catch((err) => console.error('Failed to load circles', err));

      // Opportunistically completes a join even if the user never reopens
      // /join/pending directly — the invite handshake can't depend on push
      // to tell the requester they were approved, so this same
      // app-lifecycle-triggered polling is what actually delivers it.
      completePendingJoins()
        .then((joined) => {
          if (joined) return loadFromDatabase();
        })
        .catch((err) => console.error('Failed to complete pending joins', err));
    }, [loadFromDatabase, completePendingJoins]),
  );

  const handleCancelPending = useCallback((request: PendingJoinRequest) => {
    Alert.alert(`Stop waiting to join ${request.circleName}?`, 'You can ask again with a new key.', [
      { text: 'Keep waiting', style: 'cancel' },
      {
        text: 'Cancel request',
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelPendingJoinRequest(request.id);
          } catch (err) {
            console.error('Failed to withdraw join request', err);
          }
          setPending(await getAllPendingJoinRequests());
        },
      },
    ]);
  }, []);

  /** Syncs every circle, then re-reads. Photos are left to their own queue. */
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Before the sync, so a circle this pull just joined is synced by the
      // same pull rather than sitting empty until the next one. Pulling to
      // refresh is the obvious thing to do while waiting to be let in, and
      // it used to be the one gesture that couldn't complete a join.
      await completePendingJoins().catch((err) => console.error('Failed to complete pending joins', err));

      const failed = await syncAllCircles();
      nudgePhotoQueue();
      if (failed > 0) showError('Could not refresh your circles');
    } finally {
      await loadFromDatabase().catch((err) => console.error('Failed to reload circles', err));
      setRefreshing(false);
    }
  }, [loadFromDatabase, completePendingJoins]);

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <View>
            <ThemedText type="eyebrow" style={styles.eyebrow}>
              Hearth
            </ThemedText>
            <ThemedText type="circleListHeader">Your Circles</ThemedText>
          </View>

          <Pressable onPress={() => router.push('/account')}>
            <Avatar size={44} uri={avatarUri} name={profileName} />
          </Pressable>
        </View>

        <FlatList
          data={loaded ? circles : []}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          keyExtractor={(circle) => circle.id}
          ListHeaderComponent={
            pending.length ? (
              <View style={styles.pending}>
                <ThemedText type="eyebrow" themeColor="faint">
                  {`Waiting to join · ${pending.length}`}
                </ThemedText>
                {pending.map((request) => (
                  <PendingCircleCard
                    key={request.id}
                    circleName={request.circleName}
                    createdByName={request.createdByName}
                    submittedAt={request.submittedAt}
                    onPress={() => router.push({ pathname: '/join/pending', params: { requestId: request.id } })}
                    onCancel={() => handleCancelPending(request)}
                  />
                ))}
              </View>
            ) : null
          }
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <CircleCard
              name={item.name}
              memberCount={item.memberCount}
              photoUri={item.photoUri}
              newCount={item.newCount}
              latestActivity={item.latestActivity}
              onPress={() => router.push({ pathname: '/circle/feed', params: { circleId: item.id } })}
            />
          )}
          // Only once the first read has resolved — otherwise the empty
          // state flashes before the circles arrive.
          // Not while a request is pending: the header already says what
          // is happening, and "no circles yet" under it reads as a denial.
          ListEmptyComponent={
            loaded && !pending.length ? (
              <View style={styles.empty}>
                <EmptyCirclesIcon />
                <ThemedText type="screenTitle" style={styles.emptyTitle}>
                  No circles yet
                </ThemedText>
                <ThemedText type="captionFeed" themeColor="muted" style={styles.emptyBody}>
                  Create one to share memories with the people in it — or join with a key someone
                  sent you.
                </ThemedText>
              </View>
            ) : null
          }
        />

        <FabButton
          icon={Icons.add}
          onPress={() => router.push('/circle/new')}
          style={styles.fab}
        />
      </SafeAreaView>

      <JoinSheet
        code={joinCode}
        onClose={() => setJoinCode(null)}
        onRequested={() => {
          getAllPendingJoinRequests()
            .then(setPending)
            .catch((err) => console.error('Failed to reload pending requests', err));
        }}
      />
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
    paddingTop: Spacing.topPadUnderSafeArea,
    gap: Spacing.cardListGap,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  eyebrow: {
    marginBottom: 2,
  },
  list: {
    // Grows to fill the screen so the empty state's `flex: 1` still has
    // height to centre itself in — a content container is otherwise only
    // as tall as its content, leaving the message pinned under the header.
    flexGrow: 1,
    gap: Spacing.cardListGap,
    paddingBottom: Spacing.cardListGap,
  },
  pending: {
    gap: 12,
    paddingBottom: 8,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.screenPadding,
    gap: Spacing.cardListGap,
  },
  emptyTitle: {
    textAlign: 'center',
  },
  emptyBody: {
    textAlign: 'center',
  },
  fab: {
    position: 'absolute',
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
  },
});
