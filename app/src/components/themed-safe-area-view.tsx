import { SafeAreaView, type SafeAreaViewProps } from 'react-native-safe-area-context';

import { type ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedSafeAreaViewProps = SafeAreaViewProps & {
  type?: ThemeColor;
};

/**
 * `SafeAreaView` with an explicit background — a bare one leaves the
 * inset strips it pads for to whatever's behind it, and on iOS 26 that
 * can be the system's own material rather than this app's theme: it's a
 * real native view (`NativeSafeAreaView`), not a plain `View`, so nothing
 * here guarantees it inherits a parent's color the way a transparent JS
 * view would.
 */
export function ThemedSafeAreaView({ style, type = 'background', ...rest }: ThemedSafeAreaViewProps) {
  const theme = useTheme();

  return <SafeAreaView style={[{ backgroundColor: theme[type] }, style]} {...rest} />;
}
