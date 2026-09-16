import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { Avatar } from '@/ui/components/avatar/avatar';
import { LoadingModal } from '@/ui/components/loading-modal';
import { OptionSheet } from '@/ui/components/option-sheet';
import { PrivacyInfoModal } from '@/features/account/components/privacy-info-modal';
import { ReactionChip } from '@/features/post/components/reaction-chip';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { SettingsGroups, type SettingsGroup } from '@/ui/components/settings-group';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Icons, Radius, Spacing } from '@/ui/theme/tokens';
import { getProfile, listCircles, type Profile } from '@/data/db';
import { deleteAccount, finishAccountDeletionIfPending, isAccountDeletionPending } from '@/features/account/usecases/delete-account';
import { resetEverythingForTesting } from '@/features/dev/dev-reset';
import { logTestPushPayload } from '@/features/dev/dev-test-push';
import { signOut } from '@/features/account/usecases/sign-in';
import { PushLevels, type PushLevelId } from '@/features/push-notifications/usecases/push-preferences';
import { useAppSettings } from '@/ui/theme/hooks/use-app-settings';
import { useOwnColorSeed } from '@/ui/theme/hooks/use-own-color-seed';
import { useTints } from '@/ui/theme/hooks/use-theme';
import { bytesToDataUri } from '@/core/photo/image';
import type { ThemePreference } from '@/core/services/settings';

/** How often to check whether the background erasure has finished while this screen waits on it. */
const DELETION_POLL_MS = 2_000;

/** From app.json's "version" — Constants.expoConfig is only ever missing in a context this screen doesn't run in. */
const appVersion = Constants.expoConfig?.version ?? 'Unknown';

function pushLevelLabel(level: PushLevelId): string {
  return PushLevels.find((candidate) => candidate.id === level)?.label ?? '';
}

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function AccountScreen() {
  const { settings, updateSettings } = useAppSettings();
  const tints = useTints();
  const ownColorSeed = useOwnColorSeed();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [resettingDevData, setResettingDevData] = useState(false);
  const [levelPicker, setLevelPicker] = useState(false);
  // Gates the "bring over" direction: adopting another account's seed
  // would strand any circle this device already joined under its own.
  const [hasCircles, setHasCircles] = useState(true);
  // Set once account deletion is confirmed. From here the screen only
  // ever shows the "deleting" state — there's nothing left to cancel.
  const [deletingAccount, setDeletingAccount] = useState(false);
  const deletionPollInFlight = useRef(false);

  // Polls rather than waiting on the 30s scheduler: deletion still
  // finishes via finishAccountDeletionIfPending either way (it dedupes
  // against this call), but a user staring at a spinner shouldn't wait
  // half a minute for the first check.
  useEffect(() => {
    if (!deletingAccount) return;

    const timer = setInterval(async () => {
      if (deletionPollInFlight.current) return;
      deletionPollInFlight.current = true;
      try {
        await finishAccountDeletionIfPending();
        if (!(await isAccountDeletionPending())) {
          clearInterval(timer);
          router.replace('/');
        }
      } catch (err) {
        console.error('Failed to check on account deletion', err);
      } finally {
        deletionPollInFlight.current = false;
      }
    }, DELETION_POLL_MS);

    return () => clearInterval(timer);
  }, [deletingAccount]);

  useFocusEffect(
    useCallback(() => {
      getProfile().then(setProfile);
      listCircles().then((circles) => setHasCircles(circles.length > 0));
    }, []),
  );

  /** Same shape the circle screen uses — one list, one row component, one set of spacings. */
  const settingsGroups: SettingsGroup[] = [
    {
      title: 'New circles start with',
      footnote:
        'Each circle keeps its own setting once you are in it. Change those in the circle itself. Notifications are generated on your phone; no push server is told what happened.',
      rows: [
        {
          label: 'Notify me about',
          control: { kind: 'value', text: pushLevelLabel(settings.defaultPushLevel as PushLevelId) },
          onPress: () => setLevelPicker(true),
        },
      ],
    },
    {
      title: 'Devices',
      // No list and no count: nothing tracks which devices hold your keys,
      // and nothing could revoke one if it did — every device with the
      // seed derives the same identity, so the log can't tell them apart.
      // A list you can't act on reads as control you don't have.
      footnote: 'A device you add holds the same keys as this one. There is no way to take them back.',
      rows: [
        {
          label: 'Add another device',
          description: 'Scan the code on your other phone',
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/scan-device'),
        },
        !hasCircles && {
          label: 'Bring over an existing account',
          description: 'Show a code for your old phone to scan',
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/transfer'),
        },
      ],
    },
    {
      title: 'Account recovery',
      rows: [
        {
          label: 'Recovery phrase',
          description: '12 words that restore your circles on a new phone',
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/recovery'),
        },
        {
          label: 'How the privacy works',
          description: 'What end-to-end encrypted means here',
          control: { kind: 'navigate' },
          onPress: () => setPrivacyVisible(true),
        },
      ],
    },
    {
      title: 'About',
      rows: [
        {
          label: 'Credits & attribution',
          control: { kind: 'navigate' },
          onPress: () => router.push('/account/credits'),
        },
      ],
    },
    {
      title: 'Account',
      rows: [
        {
          label: signingOut ? 'Signing out…' : 'Sign out',
          disabled: signingOut,
          onPress: handleSignOut,
        },
        {
          label: 'Delete account',
          description: "Erases everything you've posted, everywhere, then deletes your account",
          destructive: true,
          onPress: handleDeleteAccount,
        },
      ],
    },
  ];

  // Its own group, kept separate from settingsGroups: not actionable, so
  // it isn't a row, and it belongs after every real setting but ahead of
  // developer tools — sandwiched between two renders of SettingsGroups
  // rather than sortable into one flat list.
  const developerGroup: SettingsGroup = {
    title: 'Developer',
    rows: [
      __DEV__ && {
        label: resettingDevData ? 'Resetting…' : 'Reset all local data',
        description:
          '__DEV__ only. Wipes circles, keys, the master seed, and the database schema, so a changed migration actually re-runs.',
        destructive: true,
        disabled: resettingDevData,
        onPress: handleDevReset,
      },
      __DEV__ && {
        label: 'Log a test push payload',
        description: '__DEV__ only. Logs a simctl push payload this device can decrypt, for testing the iOS notification extension.',
        control: { kind: 'navigate' as const },
        onPress: () => void logTestPushPayload(),
      },
    ],
  };

  function handleDevReset() {
    Alert.alert('Reset all local data? (dev only)', 'Wipes every circle, key, the master seed, and the database itself. No undo.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          setResettingDevData(true);
          try {
            await resetEverythingForTesting();
            router.replace('/');
          } finally {
            setResettingDevData(false);
          }
        },
      },
    ]);
  }

  function handleSignOut() {
    Alert.alert(
      'Sign out?',
      'Your circles and photos stay on this device. Signing back in picks up right where you left off.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          onPress: async () => {
            setSigningOut(true);
            try {
              await signOut();
              router.replace('/');
            } finally {
              setSigningOut(false);
            }
          },
        },
      ],
    );
  }

  function handleDeleteAccount() {
    Alert.alert(
      'Delete your account?',
      "This erases everything you've posted in every circle you're in, then permanently deletes your account. This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            // No way back from here, so the screen commits to the
            // deleting state before deleteAccount even starts — nothing
            // below it is a decision the user still gets to make.
            setDeletingAccount(true);
            try {
              await deleteAccount();
            } catch (err) {
              console.error('Failed to start account deletion', err);
              setDeletingAccount(false);
            }
          },
        },
      ],
    );
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Your account" />

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.profileRow}>
            <Avatar
              size={72}
              uri={profile?.picture ? bytesToDataUri(profile.picture) : undefined}
              name={profile?.name}
              colorSeed={ownColorSeed}
            />
            <View style={styles.profileText}>
              <ThemedText type="cardTitle" numberOfLines={1}>
                {profile?.name || 'Add your name'}
              </ThemedText>
              <ThemedText type="meta" themeColor="muted">
                Visible only inside your circles
              </ThemedText>
            </View>
            <Pressable
              style={[styles.editButton, { borderColor: tints.secondaryButtonBorder }]}
              onPress={() => router.push('/profile-setup')}>
              <ThemedText type="buttonLabel">Edit</ThemedText>
            </Pressable>
          </View>


          <View style={styles.section}>
            <ThemedText type="eyebrow" themeColor="muted" style={styles.sectionLabel}>
              Appearance
            </ThemedText>

            <View style={styles.appearanceRow}>
              {APPEARANCE_OPTIONS.map((option) => (
                <ReactionChip
                  key={option.value}
                  label={option.label}
                  reacted={settings.themePreference === option.value}
                  onPress={() => updateSettings({ themePreference: option.value })}
                  style={styles.appearanceChip}
                />
              ))}
            </View>
          </View>

          <SettingsGroups groups={settingsGroups} />

          <ThemedText type="meta" themeColor="faint" style={styles.version}>
            Mimoza v{appVersion}
          </ThemedText>

          <SettingsGroups groups={[developerGroup]} />
        </ScrollView>
      </ThemedSafeAreaView>

      <OptionSheet
        visible={levelPicker}
        onClose={() => setLevelPicker(false)}
        title="Notify me about"
        options={PushLevels}
        selected={settings.defaultPushLevel as PushLevelId}
        onSelect={(level) => {
          setLevelPicker(false);
          updateSettings({ defaultPushLevel: level });
        }}
      />

      <PrivacyInfoModal visible={privacyVisible} onClose={() => setPrivacyVisible(false)} />

      <LoadingModal
        visible={deletingAccount}
        label="Deleting your account…"
        sublabel="This can take a moment. Don't close the app."
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
  content: {
    paddingBottom: Spacing.cardListGap * 2,
    gap: Spacing.cardListGap * 1.5,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  profileText: {
    flex: 1,
    gap: 4,
  },
  editButton: {
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  section: {
    gap: 10,
  },
  sectionLabel: {
    marginBottom: 0,
  },
  appearanceRow: {
    flexDirection: 'row',
    gap: 10,
  },
  appearanceChip: {
    flex: 1,
    justifyContent: 'center',
  },
  version: {
    textAlign: 'center',
  },
});
