import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionSheet, type ActionSheetOption } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/icon';
import { InviteSheet } from '@/components/invite-sheet';
import { OptionSheet } from '@/components/option-sheet';
import { PromptSheet } from '@/components/prompt-sheet';
import { ScreenHeader } from '@/components/navbar/screen-header';
import { SecondaryButton } from '@/components/secondary-button';
import { SettingsGroups, type SettingsGroup } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Icons, Radius, Spacing } from '@/constants/theme';
import { MemberRoles, type Member, type MemberRole } from '@/data/db';
import { setMemberRole } from '@/domain/usecases/circle/change-member-role';
import { resolveCircleCoverUri } from '@/domain/usecases/circle/circle-cover';
import { loadCircleDetails, type CircleDetails } from '@/domain/usecases/circle/circle-details';
import { buildDebugKeysetFlags } from '@/domain/usecases/circle/debug-keyset';
import { getOrCreateInvite, replaceInvite } from '@/domain/usecases/circle/invite-to-circle';
import { departingSuccessor } from '@/domain/usecases/circle/authority';
import { leaveCircle } from '@/domain/usecases/circle/leave-circle';
import { removeMember } from '@/domain/usecases/circle/remove-member';
import { renameCircle } from '@/domain/usecases/circle/rename-circle';
import { setCoverPhoto } from '@/domain/usecases/circle/set-cover-photo';
import {
  PushLevels,
  setCircleLevel,
  setCircleSilenced,
  type CirclePushPreferences,
  type PushLevelId,
} from '@/domain/usecases/push/push-preferences';
import { useTheme, useTints } from '@/hooks/use-theme';
import { showDone, showError } from '@/services/messages';
import { bytesToDataUri, pickAndCompressImage } from '@/services/image';

function inviteLink(code: string): string {
  return `circle://join/${code}`;
}

function formatJoined(joinedAt: number): string {
  return new Date(joinedAt).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

function pushLevelLabel(level: PushLevelId): string {
  return PushLevels.find((candidate) => candidate.id === level)?.label ?? '';
}

function formatExpiry(expiresAt: number): string {
  const days = Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'expired';
  return days === 1 ? 'expires in 1 day' : `expires in ${days} days`;
}

/** Stable identity, so `avatarUris`' memo doesn't bust on every render. */
const NO_MEMBERS: Member[] = [];

const NO_PUSH_PREFERENCES: CirclePushPreferences = { silenced: false, level: 'comments', categories: [] };

export default function CircleDetailsScreen() {
  const theme = useTheme();
  const tints = useTints();
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [details, setDetails] = useState<CircleDetails | null>(null);
  const [sharing, setSharing] = useState(false);
  const [memberMenu, setMemberMenu] = useState<Member | null>(null);
  const [inviteSheet, setInviteSheet] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [coverUri, setCoverUri] = useState<string | undefined>();
  const [levelPicker, setLevelPicker] = useState(false);

  const circle = details?.circle ?? null;
  const members = details?.members ?? NO_MEMBERS;
  const admin = details?.ownIsAdmin ?? false;
  const ownPublicKey = details?.ownPublicKey ?? null;
  const invite = details?.invite ?? null;
  const push = details?.push ?? NO_PUSH_PREFERENCES;

  /**
   * Only an admin may write `member_added` or change a role, so a circle
   * whose one admin loses their device can never add or remove anyone
   * again, including re-adding that person. No entry repairs it after the
   * fact, so promoting a second admin first is the only fix there is.
   */
  const soleAdmin = admin && members.filter((member) => member.role === MemberRoles.admin).length === 1;

  const reload = useCallback(async () => {
    if (!circleId) return;
    setDetails(await loadCircleDetails(circleId));
    setCoverUri(await resolveCircleCoverUri(circleId));
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
      reload().catch((err) => console.error('Failed to load circle details', err));
    }, [reload]),
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
              await reload();
            } catch (err) {
              console.error('Failed to remove member', err);
              showError('Could not remove that member');
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
      await reload();
      // Nothing on the roster moves until the relay accepts the change
      // and the entry syncs back, so say so rather than leave the tap
      // looking like it did nothing.
      showDone(role === MemberRoles.admin ? 'They become an admin once this syncs' : 'They stop being an admin once this syncs');
    } catch (err) {
      console.error('Failed to change member role', err);
      showError('Could not change their role');
    }
  }

  const memberMenuOptions: ActionSheetOption[] = memberMenu
    ? [
        memberMenu.role === MemberRoles.admin
          ? {
              label: 'Remove as admin',
              icon: Icons.demote,
              onPress: () => handleSetRole(memberMenu, MemberRoles.member),
            }
          : {
              label: 'Make admin',
              icon: Icons.promote,
              onPress: () => handleSetRole(memberMenu, MemberRoles.admin),
            },
        {
          label: 'Remove from circle',
          icon: Icons.removeMember,
          destructive: true,
          onPress: () => handleRemoveMember(memberMenu),
        },
      ]
    : [];

  async function handleSilenceChange(silenced: boolean) {
    if (!circleId) return;
    // Reloaded rather than held in local state: the local flag is written
    // first and is what this row reads, so a failed relay call still leaves
    // the toggle showing what was actually stored.
    try {
      await setCircleSilenced(circleId, silenced);
    } catch (err) {
      console.error('Failed to change notification settings', err);
      showError("Couldn't reach the relay, but this phone remembers");
    }
    await reload();
  }

  async function handleLevelChange(level: PushLevelId) {
    if (!circleId) return;
    setLevelPicker(false);
    try {
      await setCircleLevel(circleId, level);
    } catch (err) {
      console.error('Failed to change notification settings', err);
      showError("Couldn't reach the relay, but this phone remembers");
    }
    await reload();
  }

  async function handleShareLink() {
    if (!circleId) return;
    setSharing(true);
    try {
      const invite = await getOrCreateInvite(circleId);
      await Share.share({
        message: `Join ${circle?.name ?? 'my circle'} on Circle: ${inviteLink(invite.code)}`,
      });
    } catch (err) {
      console.error('Failed to share invite', err);
      showError('Could not create an invite');
    } finally {
      setSharing(false);
    }
  }

  /** Mints the key before opening, so the sheet never renders an empty code. */
  async function handleShowCode() {
    if (!circleId) return;
    try {
      await getOrCreateInvite(circleId);
      await reload();
      setInviteSheet(true);
    } catch (err) {
      console.error('Failed to create an invite', err);
      showError('Could not create an invite');
    }
  }

  /** Asks first: this retires every invite already handed out. */
  function handleReplaceKey() {
    if (!circleId) return;
    Alert.alert(
      'Replace the key?',
      'The old link and code stop working, so anyone still holding one can no longer ask to join. Everyone already in the circle stays in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Replace',
          style: 'destructive',
          onPress: async () => {
            setSharing(true);
            try {
              await replaceInvite(circleId);
              await reload();
            } catch (err) {
              console.error('Failed to replace the invite key', err);
              showError('Could not replace the key');
            } finally {
              setSharing(false);
            }
          },
        },
      ],
    );
  }

  async function handleLeave() {
    if (!circleId) return;
    // Named rather than left as a surprise: leaving as the last admin
    // hands the circle to someone, and this is where that can be
    // cancelled and overridden with "Make admin" on someone else.
    const successor = await departingSuccessor(circleId).catch(() => null);
    // Nobody left to invite you back, so this one really is final — worth
    // saying outright rather than letting "you will need a new key" imply
    // a way back that doesn't exist.
    const lastMember = members.length === 1;
    Alert.alert(
      `Leave ${circle?.name ?? 'this circle'}?`,
      lastMember
        ? `You are the only one left. Leaving removes ${circle?.name ?? 'this circle'} and every photo in it from this phone, and there is nobody who could invite you back.`
        : successor
          ? `The circle disappears from this phone, and ${successor.name || 'the longest-standing member'} becomes admin.`
          : 'The circle disappears from this phone, and you will need a new key to come back.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            // All local: the entry announcing the departure is queued, not
            // pushed, so this works offline and can't fail on a connection.
            try {
              await leaveCircle(circleId);
            } catch (err) {
              console.error('Failed to leave circle', err);
              showError('Could not leave the circle');
              return;
            }
            router.dismissTo('/circle');
          },
        },
      ],
    );
  }

  async function handleSetCoverPhoto() {
    if (!circleId) return;
    try {
      const picked = await pickAndCompressImage();
      if (!picked) return;
      await setCoverPhoto(circleId, picked.bytes);
      await reload();
    } catch (err) {
      console.error('Failed to set the cover photo', err);
      showError('Could not set the cover photo');
    }
  }

  async function handleRename(name: string) {
    if (!circleId) return;
    try {
      await renameCircle(circleId, name);
      setRenaming(false);
      await reload();
    } catch (err) {
      console.error('Failed to rename the circle', err);
      showError('Could not rename the circle');
      setRenaming(false);
    }
  }

  async function handleCopyDebugKeyset() {
    if (!circleId) return;
    try {
      const flags = await buildDebugKeysetFlags(circleId);
      await Clipboard.setStringAsync(flags);
      showDone('Keyset copied for decryptlog');
    } catch (err) {
      console.error('Failed to build debug keyset', err);
      showError('Could not copy the keyset');
    }
  }


  /**
   * The three things you can do with a circle's key. Its own group rather
   * than a member of `settingsGroups` because it belongs above the roster,
   * where you look when the reason you opened this screen is to add
   * someone.
   */
  const inviteGroup: SettingsGroup = {
    title: 'Invite members',
    rows: [
      {
        label: 'Share invite link',
        description: 'Sends the key however you like',
        icon: Icons.inviteLink,
        // No chevron: this hands off to the OS share sheet rather than
        // opening a view of ours to come back from.
        disabled: sharing,
        onPress: handleShareLink,
      },
      {
        label: 'Show a QR code',
        description: 'For someone standing next to you',
        icon: Icons.inviteCode,
        control: { kind: 'navigate' },
        disabled: sharing,
        onPress: handleShowCode,
      },
      {
        label: 'Replace the key',
        description: 'The old link and code stop working',
        icon: Icons.replaceKey,
        // The code sits on the row that retires it, so what "the old code"
        // means is the thing you're looking at.
        control: invite ? { kind: 'value', text: invite.code } : undefined,
        disabled: sharing,
        onPress: handleReplaceKey,
      },
    ],
    footnote: `The key only lets someone ask. You approve each person yourself before they see anything.${
      invite ? ` This one ${formatExpiry(invite.expiresAt)}.` : ''
    }`,
  };

  /**
   * Every setting on this screen, as data. Adding one is an entry here —
   * a row gated on `admin` can say so inline, and a group whose rows all
   * drop out renders nothing.
   */
  const settingsGroups: SettingsGroup[] = [
    {
      title: 'Notifications',
      footnote: push.silenced
        ? 'Silenced, so nothing from here reaches you until you switch it back on.'
        : 'Only this circle. Your other circles keep their own setting.',
      rows: [
        {
          label: 'Silence this circle',
          description: 'Nothing from here reaches your phone',
          control: { kind: 'switch', value: push.silenced, onValueChange: handleSilenceChange },
        },
        {
          label: 'Notify me about',
          control: { kind: 'value', text: pushLevelLabel(push.level) },
          disabled: push.silenced,
          onPress: () => setLevelPicker(true),
        },
      ],
    },
    {
      title: 'This circle',
      rows: [
        admin && {
          label: 'Cover photo',
          description: 'What everyone sees on the circles list',
          // Resolved the same way the list resolves it, newest-post
          // fallback included, so the row can't show a circle a different
          // face from the one you just tapped.
          control: { kind: 'image', uri: coverUri },
          onPress: handleSetCoverPhoto,
        },
        admin && {
          label: 'Rename this circle',
          description: 'Everyone sees the new name once their phone syncs',
          control: { kind: 'navigate' },
          onPress: () => setRenaming(true),
        },
      ],
    },
    {
      title: 'Careful',
      destructive: true,
      rows: [
        {
          label: `Leave ${circle?.name ?? 'this circle'}`,
          // Not "you keep the photos": `markCircleLeft` is a soft delete and
          // the bytes do survive, but every list filters left circles out,
          // so there is no screen that can still show them.
          description: 'The circle disappears from this phone. You will need a new key to come back.',
          destructive: true,
          onPress: handleLeave,
        },
      ],
    },
  ];

  function renderMemberList() {
    return (
      <>
        <View style={styles.sectionHeader}>
          <ThemedText type="eyebrow" themeColor="muted">
            Members
          </ThemedText>
          <ThemedText type="meta" themeColor="muted">
            {members.length} in the circle
          </ThemedText>
        </View>

        {members.map(renderMember)}

        {soleAdmin && members.length > 1 ? (
          <ThemedText type="meta" themeColor="faint" style={styles.adminNotice}>
            You are the only admin. If you lose this phone, nobody can be added or removed again. Tap
            someone above to make them an admin too.
          </ThemedText>
        ) : null}
      </>
    );
  }

  /** One roster row. The menu is offered on everyone but the reader — nobody demotes or removes themselves here. */
  function renderMember(member: Member) {
    return (
      <View key={member.identityPublicKey} style={[styles.memberRow, { borderBottomColor: tints.chipIdleBorder }]}>
        <Avatar size={44} uri={avatarUris.get(member.identityPublicKey)} name={member.name} />

        <View style={styles.memberInfo}>
          <View style={styles.memberNameRow}>
            <ThemedText type="postAuthor">{member.name || 'Unnamed member'}</ThemedText>
            {member.role === MemberRoles.admin ? (
              <View style={[styles.adminBadge, { backgroundColor: theme.accent }]}>
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
            <Icon icon={Icons.more} size={20} color={theme.muted} />
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Circle details" />

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <ThemedText type="screenTitle">{circle?.name ?? ''}</ThemedText>
          <ThemedText type="meta" themeColor="muted" style={styles.memberCount}>
            {members.length} {members.length === 1 ? 'person' : 'people'}
          </ThemedText>

          {admin ? <SettingsGroups groups={[inviteGroup]} /> : null}

          {renderMemberList()}

          <SettingsGroups groups={settingsGroups} />

          {__DEV__ ? (
            <View style={styles.debugZone}>
              <ThemedText type="eyebrow" themeColor="muted">
                Debug
              </ThemedText>
              <SecondaryButton label="Copy keyset for decryptlog" onPress={handleCopyDebugKeyset} />
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>

      <PromptSheet
        visible={renaming}
        title="Rename this circle"
        description="Everyone sees the new name once their phone syncs."
        initialValue={circle?.name ?? ''}
        placeholder="Circle name"
        confirmLabel="Rename"
        onCancel={() => setRenaming(false)}
        onConfirm={handleRename}
      />

      <InviteSheet
        visible={inviteSheet}
        onClose={() => setInviteSheet(false)}
        link={invite ? inviteLink(invite.code) : ''}
        code={invite?.code ?? ''}
        expiry={invite ? formatExpiry(invite.expiresAt) : undefined}
      />

      <OptionSheet
        visible={levelPicker}
        onClose={() => setLevelPicker(false)}
        title="Notify me about"
        options={PushLevels}
        selected={push.level}
        onSelect={handleLevelChange}
      />

      <ActionSheet
        visible={memberMenu !== null}
        onClose={() => setMemberMenu(null)}
        title={memberMenu?.name || 'This member'}
        avatarUri={memberMenu ? avatarUris.get(memberMenu.identityPublicKey) : undefined}
        avatarName={memberMenu?.name}
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
  },
  memberCount: {
    marginTop: 4,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: Spacing.cardListGap,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.cardListGap,
    marginBottom: 4,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
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
    borderRadius: Radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  adminBadgeText: {
    fontSize: 10.5,
    fontWeight: '600',
  },
  adminNotice: {
    marginTop: 10,
  },
  debugZone: {
    marginTop: Spacing.cardListGap,
    gap: 8,
  },
});
