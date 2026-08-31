import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { PrimaryButton } from '@/components/primary-button';
import { SecondaryButton } from '@/components/secondary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing, Tints } from '@/constants/theme';
import { getCircle, getCircleMembers, MemberRoles, type Circle, type Member } from '@/data/db';
import { getOrCreateInvite, isCircleAdmin } from '@/domain/usecases/invite-to-circle';
import { deleteCircleForEveryone, leaveCircle } from '@/domain/usecases/leave-circle';

function inviteLink(code: string): string {
  return `circle://join/${code}`;
}

function formatJoined(joinedAt: number): string {
  return new Date(joinedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export default function CircleDetailsScreen() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circle, setCircle] = useState<Circle | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [admin, setAdmin] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!circleId) return;
      Promise.all([getCircle(circleId), getCircleMembers(circleId), isCircleAdmin(circleId)]).then(
        ([circleRow, memberRows, isAdmin]) => {
          setCircle(circleRow);
          setMembers(memberRows);
          setAdmin(isAdmin);
        },
      );
    }, [circleId]),
  );

  async function handleShareLink() {
    if (!circleId) return;
    setSharing(true);
    setError(null);
    try {
      const invite = await getOrCreateInvite(circleId);
      await Share.share({ message: `Join ${circle?.name ?? 'my circle'} on Circle: ${inviteLink(invite.code)}` });
    } catch (err) {
      console.error('Failed to share invite', err);
      setError("Couldn't create an invite — try again.");
    } finally {
      setSharing(false);
    }
  }

  function handleLeave() {
    if (!circleId) return;
    Alert.alert(`Leave ${circle?.name ?? 'this circle'}?`, 'You keep the photos already downloaded. You will need a new key to come back.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          await leaveCircle(circleId);
          router.dismissTo('/circle');
        },
      },
    ]);
  }

  function handleDeleteForEveryone() {
    if (!circleId) return;
    Alert.alert(
      'Delete for everyone?',
      'Every phone in the circle erases its copy the next time it connects. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteCircleForEveryone(circleId);
              router.dismissTo('/circle');
            } catch (err) {
              console.error('Failed to delete circle', err);
              setError("Couldn't delete the circle — try again.");
            }
          },
        },
      ],
    );
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.back}>
          <BackButton label="Circle details" />
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <ThemedText type="screenTitle">{circle?.name ?? ''}</ThemedText>
          <ThemedText type="meta" themeColor="muted" style={styles.memberCount}>
            {members.length} {members.length === 1 ? 'person' : 'people'}
          </ThemedText>

          {admin ? (
            <View style={styles.inviteActions}>
              <PrimaryButton label="Share invite link" disabled={sharing} onPress={handleShareLink} />
              <SecondaryButton
                label="Show a QR code"
                onPress={() => router.push({ pathname: '/circle/invite', params: { circleId } })}
              />
              {error ? (
                <ThemedText type="captionFeed" themeColor="accent" style={styles.error}>
                  {error}
                </ThemedText>
              ) : null}
              <ThemedText type="meta" themeColor="faint" style={styles.explainer}>
                Sharing the key is the only way in. There is no directory, and nobody can request to
                join.
              </ThemedText>
            </View>
          ) : null}

          <View style={styles.sectionHeader}>
            <ThemedText type="eyebrow" themeColor="muted">
              Members
            </ThemedText>
            <ThemedText type="meta" themeColor="muted">
              {members.length} in the circle
            </ThemedText>
          </View>

          {members.map((member) => (
            <View key={member.publicKey} style={styles.memberRow}>
              <View style={styles.memberInfo}>
                <View style={styles.memberNameRow}>
                  <ThemedText type="postAuthor">{member.name || 'Unnamed member'}</ThemedText>
                  {member.role === MemberRoles.admin ? (
                    <View style={styles.adminBadge}>
                      <ThemedText type="meta" themeColor="accentLabel" style={styles.adminBadgeText}>
                        Admin
                      </ThemedText>
                    </View>
                  ) : null}
                </View>
                <ThemedText type="meta" themeColor="muted">
                  Joined {formatJoined(member.joinedAt)}
                </ThemedText>
              </View>
            </View>
          ))}

          <View style={styles.dangerZone}>
            <Pressable style={styles.dangerRow} onPress={handleLeave}>
              <ThemedText type="postAuthor" themeColor="danger">
                Leave {circle?.name ?? 'this circle'}
              </ThemedText>
              <ThemedText type="meta" themeColor="muted">
                You keep the photos already downloaded. You will need a new key to come back.
              </ThemedText>
            </Pressable>

            {admin ? (
              <Pressable style={styles.dangerRowLast} onPress={handleDeleteForEveryone}>
                <ThemedText type="postAuthor" themeColor="danger">
                  Delete for everyone
                </ThemedText>
                <ThemedText type="meta" themeColor="muted">
                  Admins only. Every phone in the circle erases its copy the next time it connects.
                  This cannot be undone.
                </ThemedText>
              </Pressable>
            ) : null}
          </View>
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
  memberCount: {
    marginTop: 4,
    marginBottom: Spacing.cardListGap,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: Spacing.cardListGap,
  },
  inviteActions: {
    gap: 12,
    marginBottom: Spacing.cardListGap,
  },
  error: {
    textAlign: 'center',
  },
  explainer: {
    textAlign: 'center',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Tints.chipIdleBorder,
  },
  memberInfo: {
    flex: 1,
    gap: 2,
  },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  adminBadge: {
    backgroundColor: Colors.dark.accent,
    borderRadius: Radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  adminBadgeText: {
    fontSize: 10.5,
    fontWeight: '600',
  },
  dangerZone: {
    marginTop: Spacing.cardListGap,
    borderColor: Tints.dangerWashBorder,
    borderWidth: 1,
    borderRadius: Radius.notice,
    paddingHorizontal: Spacing.screenPadding,
  },
  dangerRow: {
    gap: 2,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Tints.dangerWashBorder,
  },
  dangerRowLast: {
    gap: 2,
    paddingVertical: 14,
  },
});
