import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';

export type CircleCardProps = {
  name: string;
  memberCount: number;
  onPress?: () => void;
};

export function CircleCard({ name, memberCount, onPress }: CircleCardProps) {
  return (
    <Pressable onPress={onPress}>
      <ThemedView type="surface" style={styles.card}>
        <ThemedText type="cardTitle">{name}</ThemedText>
        <ThemedText type="meta" themeColor="muted">
          {memberCount} people
        </ThemedText>
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.circleCard,
    padding: Spacing.screenPadding,
    gap: 4,
  },
});
