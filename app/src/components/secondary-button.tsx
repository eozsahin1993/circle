import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ButtonHeight, Colors, Radius, Tints } from '@/constants/theme';

export type SecondaryButtonProps = PressableProps & {
  label: string;
};

export function SecondaryButton({ label, style, ...rest }: SecondaryButtonProps) {
  return (
    <Pressable style={style} {...rest}>
      {({ pressed }) => (
        <View style={[styles.button, pressed && { borderColor: Colors.dark.accent }]}>
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
    borderColor: Tints.secondaryButtonBorder,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
});
