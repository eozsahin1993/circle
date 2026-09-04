import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionSheet, type ActionSheetOption } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { BackButton } from '@/components/back-button';
import { PrimaryButton } from '@/components/primary-button';
import { SecondaryButton } from '@/components/secondary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing, Tints } from '@/constants/theme';
import { getCircleSummary, getCircleMembers, MemberRoles, type CircleListRow, type Member, type MemberRole } from '@/data/db';
import { setMemberRole } from '@/domain/usecases/circle/change-member-role';
import { buildDebugKeysetFlags } from '@/domain/usecases/circle/debug-keyset';
import { getOrCreateInvite, isCircleAdmin } from '@/domain/usecases/circle/invite-to-circle';
import { deleteCircleForEveryone, leaveCircle } from '@/domain/usecases/circle/leave-circle';
import { removeMember } from '@/domain/usecases/circle/remove-member';
import { useTheme } from '@/hooks/use-theme';
import { getCircleIdentity } from '@/services/keystore';
import { bytesToDataUri } from '@/services/image';
import { bytesToHex } from '@noble/curves/utils.js';

function inviteLink(code: string): string {
  return `circle://join/${code}`;
}

function formatJoined(joinedAt: number): string {
  return new Date(joinedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export default function CircleDetailsScreen() {
  const theme = useTheme();
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circle, setCircle] = useState<CircleListRow | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [admin, setAdmin] = useState(false);
  const [ownPublicKey, setOwnPublicKey] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberMenu, setMemberMenu] = useState<Member | null>(null);

  const loadMembers = useCallback(async () => {
    if (!circleId) return;
    setMembers(await getCircleMembers(circleId));
  }, [circleId]);

  // Encoded once per roster change rather than on every render. Member
  // pictures are avatar-sized thumbnails, so a data URI is cheap here —
  // unlike a circle cover, which goes through the photo cache instead.
  const avatarUris = useMemo(
    () =>
      new Map(
        members
          .filter((member) => member.picture)
          .map((member) => [member.identityPublicKey, bytesToDataUri(member.picture!)]),
      ),
    [members],
  );

  useFocusEffect(
    useCallback(() => {
      if (!circleId) return;
      Promise.all([getCircleSummary(circleId), getCircleMembers(circleId), isCircleAdmin(circleId), getCircleIdentity(circleId)]).then(
        ([circleRow, memberRows, isAdmin, identity]) => {
          setCircle(circleRow);
          setMembers(memberRows);
          setAdmin(isAdmin);
          setOwnPublicKey(identity ? bytesToHex(identity.publicKey) : null);
        },
      );
    }, [circleId]),
  );

  function handleRemoveMember(member: Member) {
    if (!circleId) return;
    Alert.alert(
      `Remove ${member.name || 'this member'}?`,
      "They'll disappear from the roster and lose the ability to decrypt anything new, once this and everyone else's devices sync. They keep what they already downloaded.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeMember(circleId, member.identityPublicKey);
              await loadMembers();
            } catch (err) {
              console.error('Failed to remove member', err);
              setError("Couldn't remove that member — try again.");
            }
          },
        },
      ],
    );
  }

  async function handleSetRole(member: Member, role: MemberRole) {
    if (!circleId) return;
    try {
      await setMemberRole(circleId, member.identityPublicKey, role);
      await loadMembers();
    } catch (err) {
      console.error('Failed to change member role', err);
      setError("Couldn't change that member's role — try again.");
    }
  }

  const memberMenuOptions: ActionSheetOption[] = memberMenu
    ? [
        memberMenu.role === MemberRoles.admin
          ? { label: 'Remove as admin', icon: 'shield-off', onPress: () => handleSetRole(memberMenu, MemberRoles.member) }
          : { label: 'Make admin', icon: 'shield', onPress: () => handleSetRole(memberMenu, MemberRoles.admin) },
        { label: 'Remove from circle', icon: 'user-x', destructive: true, onPress: () => handleRemoveMember(memberMenu) },
      ]
    : [];

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

  async function handleCopyDebugKeyset() {
    if (!circleId) return;
    try {
      const flags = await buildDebugKeysetFlags(circleId);
      await Clipboard.setStringAsync(flags);
      Alert.alert('Copied', "Paste after `go run ./cmd/decryptlog --table <table>` on your machine.");
    } catch (err) {
      console.error('Failed to build debug keyset', err);
      Alert.alert("Couldn't copy the keyset", String(err));
    }
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
                Sharing the key is the only way in — there is no directory. Anyone who has it can
                request to join, but you still have to approve them.
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
            <View key={member.identityPublicKey} style={styles.memberRow}>
              <Avatar size={44} uri={avatarUris.get(member.identityPublicKey)} />
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
              {admin && member.identityPublicKey !== ownPublicKey ? (
                <Pressable hitSlop={12} style={styles.memberMenuButton} onPress={() => setMemberMenu(member)}>
                  <Feather name="more-vertical" size={20} color={theme.muted} />
                </Pressable>
              ) : null}
            </View>
          ))}

          {__DEV__ ? (
            <View style={styles.debugZone}>
              <ThemedText type="eyebrow" themeColor="muted">
                Debug
              </ThemedText>
              <SecondaryButton label="Copy keyset for decryptlog" onPress={handleCopyDebugKeyset} />
            </View>
          ) : null}

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

      <ActionSheet
        visible={memberMenu !== null}
        onClose={() => setMemberMenu(null)}
        title={memberMenu?.name || 'This member'}
        avatarUri={memberMenu ? avatarUris.get(memberMenu.identityPublicKey) : undefined}
        options={memberMenuOptions}
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
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Tints.chipIdleBorder,
  },
  memberInfo: {
    flex: 1,
    gap: 2,
  },
  memberMenuButton: {
    padding: 4,
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
  debugZone: {
    marginTop: Spacing.cardListGap,
    gap: 8,
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
