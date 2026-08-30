import { StyleSheet, Text, type TextProps } from 'react-native';

import { Type, type ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextType = keyof typeof Type;

export type ThemedTextProps = TextProps & {
  type?: ThemedTextType;
  themeColor?: ThemeColor;
};

/** Default text color per type, per the handoff's text ramp — override with `themeColor`. */
const defaultColor: Record<ThemedTextType, ThemeColor> = {
  onboardingHeadline: 'text',
  circleListHeader: 'text',
  screenTitle: 'text',
  cardTitle: 'text',
  postAuthor: 'text',
  captionDetail: 'body',
  captionFeed: 'body',
  comment: 'secondary',
  buttonLabel: 'text',
  meta: 'faint',
  eyebrow: 'faint',
  inviteKey: 'accentBright',
};

export function ThemedText({ style, type = 'captionFeed', themeColor, ...rest }: ThemedTextProps) {
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
