import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, Text, type PressableProps } from 'react-native';

import { Colors, Fonts } from '@/constants/theme';

export type FabButtonProps = PressableProps & {
  /** Single glyph shown in the button, e.g. "+". */
  icon: string;
  size?: number;
};

/** A circular, floating primary action — same accent gradient as PrimaryButton. */
export function FabButton({ icon, size = 60, style, ...rest }: FabButtonProps) {
  return (
    <Pressable style={style} {...rest}>
      {({ pressed }) => (
        <LinearGradient
          colors={[Colors.dark.accent, Colors.dark.accentBright]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[
            styles.button,
            { width: size, height: size, borderRadius: size / 2 },
            pressed && styles.pressed,
          ]}>
          <Text style={styles.icon}>{icon}</Text>
        </LinearGradient>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    elevation: 10,
  },
  pressed: {
    opacity: 0.85,
  },
  icon: {
    fontFamily: Fonts.sansMedium,
    fontSize: 28,
    color: Colors.dark.accentLabel,
  },
});
