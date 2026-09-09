import { Pressable, type PressableProps } from 'react-native';

import { Icon, type IconGlyph } from '@/components/icon';
import { useTheme } from '@/hooks/use-theme';

export type HeaderIconButtonProps = Omit<PressableProps, 'style'> & {
  icon: IconGlyph;
  /** Whether the state it toggles is on — the album bookmark, say. Fills the glyph as well as colouring it. */
  active?: boolean;
};

/** The back arrow's size, so nothing in the header row is drawn at a different weight. */
const SIZE = 22;

/** One control in a `ScreenHeader`'s right-hand slot. Bare glyph, no chrome — the header's own row gives it its height. */
export function HeaderIconButton({ icon, active, ...rest }: HeaderIconButtonProps) {
  const theme = useTheme();

  return (
    <Pressable hitSlop={12} {...rest}>
      <Icon
        icon={icon}
        size={SIZE}
        color={active ? theme.accentBright : theme.secondary}
        filled={active}
      />
    </Pressable>
  );
}
