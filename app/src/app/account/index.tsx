import { Feather } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import * as Device from 'expo-device';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { BackButton } from '@/components/back-button';
import { PrivacyInfoModal } from '@/components/privacy-info-modal';
import { ReactionChip } from '@/components/reaction-chip';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing, Tints } from '@/constants/theme';
import { getProfile, type Profile } from '@/data/db';
import { signOut } from '@/domain/usecases/sign-in';
import { useAppSettings } from '@/hooks/use-app-settings';
import { useTheme } from '@/hooks/use-theme';
import { bytesToDataUri } from '@/services/image';
import type { ThemePreference } from '@/services/settings';

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

// Stated as a plan, not an enforced limit — there's no device-linking flow
// to add a second device yet, so nothing actually counts toward this today.
const DEVICE_CAP = 3;

function formatAdded(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export default function AccountScreen() {
  const theme = useTheme();
  const { settings, updateSettings } = useAppSettings();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getProfile().then(setProfile);
    }, []),
  );

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
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.back}>
          <BackButton label="Your account" />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.profileRow}>
            <Avatar size={72} uri={profile?.picture ? bytesToDataUri(profile.picture) : undefined} />
            <View style={styles.profileText}>
              <ThemedText type="screenTitle" numberOfLines={1}>
                {profile?.name || 'Add your name'}
              </ThemedText>
              <ThemedText type="meta" themeColor="muted">
                Visible only inside your circles
              </ThemedText>
            </View>
            <Pressable style={styles.editButton} onPress={() => router.push('/profile-setup')}>
              <ThemedText type="buttonLabel">Edit</ThemedText>
            </Pressable>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <ThemedText type="eyebrow" themeColor="muted">
                Devices holding your keys
              </ThemedText>
              <ThemedText type="meta" themeColor="muted">
                1 of {DEVICE_CAP} allowed
              </ThemedText>
            </View>

            <ThemedView type="surface" style={styles.card}>
              <View style={styles.deviceRow}>
                <View style={[styles.statusDot, { backgroundColor: theme.accent }]} />
                <View style={styles.deviceInfo}>
                  <ThemedText type="postAuthor">{Device.modelName ?? 'This device'} · this phone</ThemedText>
                  <ThemedText type="meta" themeColor="muted">
                    {profile ? `Added ${formatAdded(profile.createdAt)} · ` : ''}in use now
                  </ThemedText>
                </View>
                <ThemedText type="meta" themeColor="muted">
                  This one
                </ThemedText>
              </View>

              <Pressable
                style={styles.addDeviceRow}
                onPress={() =>
                  Alert.alert(
                    'Not available yet',
                    'Linking a second device isn’t built yet — this phone is the only one that can post to your circles right now.',
                  )
                }>
                <ThemedText type="postAuthor" themeColor="accentBright">
                  Add another device
                </ThemedText>
                <Feather name="chevron-right" size={18} color={theme.accentBright} />
              </Pressable>
            </ThemedView>

            <ThemedText type="meta" themeColor="faint" style={styles.explainer}>
              Revoking a device removes its copy of your keys. Photos already on it stay on it.
            </ThemedText>
          </View>

          <View style={styles.section}>
            <ThemedText type="eyebrow" themeColor="muted" style={styles.sectionLabel}>
              Notify me about
            </ThemedText>

            <ThemedView type="surface" style={styles.card}>
              <ToggleRow
                label="New photos in a circle"
                value={settings.notifyNewPhotos}
                onValueChange={(value) => updateSettings({ notifyNewPhotos: value })}
              />
              <ToggleRow
                label="Comments and reactions"
                value={settings.notifyCommentsReactions}
                onValueChange={(value) => updateSettings({ notifyCommentsReactions: value })}
              />
              <ToggleRow
                label="Someone joins a circle"
                value={settings.notifyMemberJoined}
                onValueChange={(value) => updateSettings({ notifyMemberJoined: value })}
                last
              />
            </ThemedView>

            <ThemedText type="meta" themeColor="faint" style={styles.explainer}>
              Notifications are generated on your phone. No push server is told what happened.
            </ThemedText>
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

          <View style={styles.section}>
            <ThemedText type="eyebrow" themeColor="muted" style={styles.sectionLabel}>
              Account recovery
            </ThemedText>

            <ThemedView type="surface" style={styles.card}>
              <Pressable style={styles.linkRow} onPress={() => router.push('/account/recovery')}>
                <View style={styles.linkText}>
                  <ThemedText type="postAuthor">Recovery phrase</ThemedText>
                  <ThemedText type="meta" themeColor="muted">
                    12 words that restore your circles on a new phone
                  </ThemedText>
                </View>
                <Feather name="chevron-right" size={18} color={theme.muted} />
              </Pressable>

              <Pressable style={styles.linkRowLast} onPress={() => setPrivacyVisible(true)}>
                <View style={styles.linkText}>
                  <ThemedText type="postAuthor">How the privacy works</ThemedText>
                  <ThemedText type="meta" themeColor="muted">
                    What end-to-end encrypted means here
                  </ThemedText>
                </View>
                <Feather name="chevron-right" size={18} color={theme.muted} />
              </Pressable>
            </ThemedView>
          </View>

          <Pressable style={styles.signOutRow} onPress={handleSignOut} disabled={signingOut}>
            <ThemedText type="postAuthor" themeColor="accent">
              {signingOut ? 'Signing out…' : 'Sign out'}
            </ThemedText>
          </Pressable>
        </ScrollView>
      </SafeAreaView>

      <PrivacyInfoModal visible={privacyVisible} onClose={() => setPrivacyVisible(false)} />
    </ThemedView>
  );
}

type ToggleRowProps = {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  last?: boolean;
};

function ToggleRow({ label, value, onValueChange, last }: ToggleRowProps) {
  return (
    <View style={last ? styles.toggleRowLast : styles.toggleRow}>
      <ThemedText type="postAuthor" style={styles.toggleLabel}>
        {label}
      </ThemedText>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: Tints.chipIdleBorder, true: Colors.dark.accent }}
      />
    </View>
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
    borderColor: Tints.secondaryButtonBorder,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  section: {
    gap: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionLabel: {
    marginBottom: 0,
  },
  card: {
    borderColor: Tints.chipIdleBorder,
    borderWidth: 1,
    borderRadius: Radius.notice,
    paddingHorizontal: Spacing.screenPadding,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Tints.chipIdleBorder,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  deviceInfo: {
    flex: 1,
    gap: 2,
  },
  addDeviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  explainer: {
    paddingHorizontal: 4,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Tints.chipIdleBorder,
  },
  toggleRowLast: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  toggleLabel: {
    flex: 1,
    marginRight: 12,
  },
  appearanceRow: {
    flexDirection: 'row',
    gap: 10,
  },
  appearanceChip: {
    flex: 1,
    justifyContent: 'center',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Tints.chipIdleBorder,
  },
  linkRowLast: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  linkText: {
    flex: 1,
    gap: 2,
    marginRight: 12,
  },
  signOutRow: {
    alignItems: 'center',
    paddingVertical: 14,
  },
});
