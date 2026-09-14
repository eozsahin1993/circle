/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors, Tints } from '@/ui/theme/tokens';
import { useAppSettings } from '@/ui/theme/hooks/use-app-settings';

export function useTheme() {
  const { scheme } = useAppSettings();

  return Colors[scheme];
}

/** The scheme-matched half of `Tints` — see its doc comment for why dark and light need different rgb bases. */
export function useTints() {
  const { scheme } = useAppSettings();

  return Tints[scheme];
}
