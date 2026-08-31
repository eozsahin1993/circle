import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { CircleCard } from '@/components/circle-card';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getProfile } from '@/data/db';
import { bytesToDataUri } from '@/services/image';

export default function CircleListScreen() {
  const [avatarUri, setAvatarUri] = useState<string | undefined>();

  // Re-check on every focus, not just mount — picture may have just
  // changed on the profile screen this screen returns to.
  useFocusEffect(
    useCallback(() => {
      getProfile().then((profile) => {
        setAvatarUri(profile?.picture ? bytesToDataUri(profile.picture) : undefined);
      });
    }, []),
  );

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <View>
            <ThemedText type="eyebrow" style={styles.eyebrow}>
              Hearth
            </ThemedText>
            <ThemedText type="circleListHeader">Circles</ThemedText>
          </View>

          <Pressable onPress={() => router.push('/profile-setup')}>
            <Avatar size={44} uri={avatarUri} />
          </Pressable>
        </View>

        <CircleCard name="Nana's House" memberCount={9} onPress={() => router.push('/feed')} />

        <PrimaryButton
          label="New circle"
          onPress={() => router.push('/circle/new')}
          style={styles.pinnedButton}
        />
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
  pinnedButton: {
    position: 'absolute',
    left: Spacing.screenPadding,
    right: Spacing.screenPadding,
    bottom: Spacing.pinnedButtonFromBottom,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    elevation: 10,
  },
});
