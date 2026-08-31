import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

export type BackButtonProps = {
  /** Shown next to the arrow, e.g. "Circle details" — omit for a bare arrow. */
  label?: string;
};

/** Goes back if there's history to go back to — falls back to the circle list otherwise, e.g. after a deep link or a redirect that reset the stack. */
function goBack() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/circle');
  }
}

export function BackButton({ label }: BackButtonProps) {
  const theme = useTheme();

  return (
    <Pressable hitSlop={12} style={label ? styles.row : undefined} onPress={goBack}>
      <Feather name="arrow-left" size={22} color={theme.secondary} />
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
    alignItems: 'center',
    gap: 10,
  },
});
