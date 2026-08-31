import { Pressable, StyleSheet, View } from 'react-native';

import { AvatarStack } from '@/components/avatar-stack';
import { BackButton } from '@/components/back-button';
import { ThemedText } from '@/components/themed-text';

export type CircleHeaderProps = {
  name: string;
  memberCount: number;
  /** Opens the circle's Details sheet — members, invite, settings. */
  onPressDetails?: () => void;
};

export function CircleHeader({ name, memberCount, onPressDetails }: CircleHeaderProps) {
  return (
    <View style={styles.row}>
      <View style={styles.back}>
        <BackButton />
      </View>

      <Pressable style={styles.titles} onPress={onPressDetails}>
        <ThemedText type="screenTitle">{name}</ThemedText>
        <ThemedText type="meta" themeColor="muted">
          {memberCount} people · tap for details
        </ThemedText>
      </Pressable>

      <Pressable onPress={onPressDetails}>
        <AvatarStack count={memberCount} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  back: {
    alignSelf: 'flex-start',
    paddingTop: 6,
  },
  titles: {
    flex: 1,
    gap: 4,
  },
});
