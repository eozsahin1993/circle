import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ButtonHeight, Radius } from '@/constants/theme';
import { useTheme, useTints } from '@/hooks/use-theme';

export type SecondaryButtonProps = PressableProps & {
  label: string;
};

export function SecondaryButton({ label, style, ...rest }: SecondaryButtonProps) {
  const theme = useTheme();
  const tints = useTints();

  return (
    <Pressable style={style} {...rest}>
      {({ pressed }) => (
        <View
          style={[
            styles.button,
            { borderColor: pressed ? theme.accent : tints.secondaryButtonBorder },
          ]}>
          <ThemedText type="buttonLabel">{label}</ThemedText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: ButtonHeight.primary,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
});
