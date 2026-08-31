import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';

export type BackButtonProps = {
  /** Shown next to the arrow, e.g. "Circle details" — omit for a bare arrow. */
  label?: string;
};

export function BackButton({ label }: BackButtonProps) {
  return (
    <Pressable hitSlop={12} style={label ? styles.row : undefined} onPress={() => router.back()}>
      <ThemedText type="cardTitle" themeColor="secondary">
        ←
      </ThemedText>
      {label ? (
        <ThemedText type="captionFeed" themeColor="secondary">
          {label}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
  },
});
