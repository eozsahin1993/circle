/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors } from '@/constants/theme';
import { useAppSettings } from '@/hooks/use-app-settings';

export function useTheme() {
  const { scheme } = useAppSettings();

  return Colors[scheme];
}
