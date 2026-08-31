import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, type PressableProps } from 'react-native';

import { Colors } from '@/constants/theme';

export type FabButtonProps = PressableProps & {
  /** Feather icon name, e.g. "plus". */
  icon: React.ComponentProps<typeof Feather>['name'];
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
          <Feather name={icon} size={size * 0.42} color={Colors.dark.accentLabel} />
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
});
