import { Feather } from '@expo/vector-icons';
import { Pressable, type PressableProps } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import type { ThemeColor } from '@/constants/theme';

export type HeaderIconButtonProps = Omit<PressableProps, 'style'> & {
  icon: keyof typeof Feather.glyphMap;
  /** Lit when the state it toggles is on — the album bookmark, say. */
  active?: boolean;
};

/** One control in a `ScreenHeader`'s right-hand slot. Bare glyph, no chrome — the header's own row gives it its height. */
export function HeaderIconButton({ icon, active, ...rest }: HeaderIconButtonProps) {
  const theme = useTheme();
  const color: ThemeColor = active ? 'accentBright' : 'secondary';

  return (
    <Pressable hitSlop={12} {...rest}>
      <Feather name={icon} size={21} color={theme[color]} />
    </Pressable>
  );
}
