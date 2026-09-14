import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/core/theme/themed-safe-area-view';

import { Avatar } from '@/core/components/avatar';
import { OptionSheet } from '@/core/components/option-sheet';
import { PrivacyInfoModal } from '@/features/account/components/privacy-info-modal';
import { ReactionChip } from '@/features/post/components/reaction-chip';
import { ScreenHeader } from '@/core/components/navbar/screen-header';
import { SettingsGroups, type SettingsGroup } from '@/core/components/settings-group';
import { ThemedText } from '@/core/theme/themed-text';
import { ThemedView } from '@/core/theme/themed-view';
import { Icons, Radius, Spacing } from '@/core/theme/tokens';
import { getProfile, listCircles, type Profile } from '@/data/db';
import { resetEverythingForTesting } from '@/features/dev/dev-reset';
import { logTestPushPayload } from '@/features/dev/dev-test-push';
import { signOut } from '@/features/account/usecases/sign-in';
import { PushLevels, type PushLevelId } from '@/features/push-notifications/usecases/push-preferences';
import { useAppSettings } from '@/core/theme/use-app-settings';
import { useOwnColorSeed } from '@/core/theme/use-own-color-seed';
import { useTints } from '@/core/theme/use-theme';
import { bytesToDataUri } from '@/core/photo/image';
import type { ThemePreference } from '@/core/services/settings';

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
    },
  ];

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
      'Your circles and photos stay on this device — signing back in picks up right where you left off.',
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
              <ThemedText type="screenTitle" numberOfLines={1}>
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

          <Pressable style={styles.signOutRow} onPress={handleSignOut} disabled={signingOut}>
            <ThemedText type="postAuthor" themeColor="accent">
              {signingOut ? 'Signing out…' : 'Sign out'}
            </ThemedText>
          </Pressable>

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
  signOutRow: {
    alignItems: 'center',
    paddingVertical: 14,
  },
});
