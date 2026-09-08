import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable } from 'react-native';

import { Icons } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type BackButtonProps = {
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

/** The arrow alone. A screen's title sits beside it but outside it — see `ScreenHeader`. */
export function BackButton({ variant = 'back' }: BackButtonProps) {
  const theme = useTheme();

  return (
    <Pressable hitSlop={12} onPress={goBack}>
      <Feather name={variant === 'close' ? Icons.close : Icons.back} size={22} color={theme.secondary} />
    </Pressable>
  );
}
