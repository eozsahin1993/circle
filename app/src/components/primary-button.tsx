import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, type PressableProps } from 'react-native';

import { ButtonHeight, Colors, Radius } from '@/constants/theme';
import { ThemedText } from '@/components/themed-text';

export type PrimaryButtonProps = PressableProps & {
  label: string;
};

export function PrimaryButton({ label, style, ...rest }: PrimaryButtonProps) {
  return (
    <Pressable style={style} {...rest}>
      {({ pressed }) => (
        <LinearGradient
          colors={[Colors.dark.accent, Colors.dark.accentBright]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.button, pressed && styles.pressed]}>
          <ThemedText type="buttonLabel" themeColor="accentLabel">
            {label}
          </ThemedText>
        </LinearGradient>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: ButtonHeight.primary,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  pressed: {
    opacity: 0.85,
  },
});
