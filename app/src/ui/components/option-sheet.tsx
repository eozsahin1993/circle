import { Pressable, StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/ui/components/bottom-sheet';
import { Icon } from '@/ui/components/icon';
import { ThemedText } from '@/ui/theme/themed-text';
import { Icons, Space, Spacing } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

export type SheetOption<Id extends string> = {
  id: Id;
  label: string;
  description?: string;
};

export type OptionSheetProps<Id extends string> = {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: readonly SheetOption<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
};

/** Picks one of a short, fixed set. The current one is marked, not re-stated elsewhere. */
export function OptionSheet<Id extends string>({
  visible,
  onClose,
  title,
  options,
  selected,
  onSelect,
}: OptionSheetProps<Id>) {
  const theme = useTheme();
  const tints = useTints();

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.body}>
        <ThemedText type="titleLarge" style={styles.title}>
          {title}
        </ThemedText>

        {options.map((option) => (
          <Pressable
            key={option.id}
            style={[styles.row, { borderBottomColor: tints.chipIdleBorder }]}
            onPress={() => onSelect(option.id)}>
            <View style={styles.text}>
              <ThemedText type="titleSmall">{option.label}</ThemedText>
              {option.description ? (
                <ThemedText type="labelSmall" themeColor="muted">
                  {option.description}
                </ThemedText>
              ) : null}
            </View>
            {option.id === selected ? <Icon icon={Icons.done} size={20} color={theme.accentBright} /> : null}
          </Pressable>
        ))}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: Spacing.screenPadding,
  },
  title: {
    marginBottom: Space.s200,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
    paddingVertical: Space.s400,
    borderBottomWidth: 1,
  },
  text: {
    flex: 1,
    gap: Space.s100,
  },
});
