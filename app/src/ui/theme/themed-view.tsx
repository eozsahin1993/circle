import { View, type ViewProps } from 'react-native';

import { type ThemeColor } from '@/core/theme/tokens';
import { useTheme } from '@/core/theme/use-theme';

export type ThemedViewProps = ViewProps & {
  type?: ThemeColor;
};

export function ThemedView({ style, type = 'background', ...otherProps }: ThemedViewProps) {
  const theme = useTheme();

  return <View style={[{ backgroundColor: theme[type] }, style]} {...otherProps} />;
}
