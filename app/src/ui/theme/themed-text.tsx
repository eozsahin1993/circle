import { StyleSheet, Text, type TextProps } from 'react-native';

import { Type, type ThemeColor } from '@/ui/theme/tokens';
import { useTheme } from '@/ui/theme/hooks/use-theme';

export type ThemedTextType = keyof typeof Type;

export type ThemedTextProps = TextProps & {
  type?: ThemedTextType;
  themeColor?: ThemeColor;
};

/** Default text color per type, per the handoff's text ramp — override with `themeColor`. */
const defaultColor: Record<ThemedTextType, ThemeColor> = {
  headlineLarge: 'text',
  headlineSmall: 'text',
  titleLarge: 'text',
  titleMedium: 'text',
  titleSmall: 'text',
  bodyLarge: 'body',
  bodyMedium: 'body',
  bodySmall: 'secondary',
  labelLarge: 'text',
  labelMedium: 'secondary',
  labelSmall: 'faint',
  code: 'accentBright',
};

export function ThemedText({ style, type = 'bodyMedium', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();

  return (
    <Text
      style={[
        { color: theme[themeColor ?? defaultColor[type]] },
        styles[type],
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create(Type);
