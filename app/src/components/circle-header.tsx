import { Pressable, StyleSheet, View } from 'react-native';

import { AvatarStack } from '@/components/avatar-stack';
import { BackButton } from '@/components/back-button';
import { ThemedText } from '@/components/themed-text';

export type CircleHeaderProps = {
  name: string;
  memberCount: number;
  onPressPrivacy?: () => void;
};

export function CircleHeader({ name, memberCount, onPressPrivacy }: CircleHeaderProps) {
  return (
    <View style={styles.row}>
      <View style={styles.back}>
        <BackButton />
      </View>

      <View style={styles.titles}>
        <ThemedText type="screenTitle">{name}</ThemedText>
        <Pressable onPress={onPressPrivacy}>
          <ThemedText type="meta" themeColor="muted">
            {memberCount} people · tap for privacy detail
          </ThemedText>
        </Pressable>
      </View>

      <AvatarStack count={memberCount} />
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
