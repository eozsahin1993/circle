import { Feather, Ionicons } from '@expo/vector-icons';
import { Pressable, type PressableProps } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

export type HeaderIconButtonProps = Omit<PressableProps, 'style'> & {
  icon: keyof typeof Feather.glyphMap;
  /**
   * Drawn instead while `active`, filled and in the accent — see
   * `FilledIcons`. Without one, an active button only changes colour.
   */
  activeIcon?: keyof typeof Ionicons.glyphMap;
  /** Whether the state it toggles is on — the album bookmark, say. */
  active?: boolean;
};

const SIZE = 21;

/** One control in a `ScreenHeader`'s right-hand slot. Bare glyph, no chrome — the header's own row gives it its height. */
export function HeaderIconButton({ icon, activeIcon, active, ...rest }: HeaderIconButtonProps) {
  const theme = useTheme();
  const color = active ? theme.accentBright : theme.secondary;

  return (
    <Pressable hitSlop={12} {...rest}>
      {active && activeIcon ? (
        <Ionicons name={activeIcon} size={SIZE} color={color} />
      ) : (
        <Feather name={icon} size={SIZE} color={color} />
      )}
    </Pressable>
  );
}
