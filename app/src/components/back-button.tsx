import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Icons } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type BackButtonProps = {
  /** Shown next to the arrow, e.g. "Circle details" — omit for a bare arrow. */
  label?: string;
  /**
   * The affordance, not the glyph: 'back' returns to where you came from,
   * 'close' dismisses a compose screen. Both go back — this only changes
   * what the button looks like it does.
   */
  variant?: 'back' | 'close';
};

/** Goes back if there's history to go back to — falls back to the circle list otherwise, e.g. after a deep link or a redirect that reset the stack. */
function goBack() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/circle');
  }
}

export function BackButton({ label, variant = 'back' }: BackButtonProps) {
  const theme = useTheme();

  return (
    <Pressable hitSlop={12} style={label ? styles.row : undefined} onPress={goBack}>
      <Feather name={variant === 'close' ? Icons.close : Icons.back} size={22} color={theme.secondary} />
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
