import { router } from 'expo-router';
import { Pressable } from 'react-native';

import { ThemedText } from '@/components/themed-text';

export function BackButton() {
  return (
    <Pressable hitSlop={12} onPress={() => router.back()}>
      <ThemedText type="cardTitle" themeColor="secondary">
        ←
      </ThemedText>
    </Pressable>
  );
}
