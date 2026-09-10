import { Pressable, StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/bottom-sheet';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Icons, Spacing, Tints } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

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

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.body}>
        <ThemedText type="cardTitle" style={styles.title}>
          {title}
        </ThemedText>

        {options.map((option) => (
          <Pressable key={option.id} style={styles.row} onPress={() => onSelect(option.id)}>
            <View style={styles.text}>
              <ThemedText type="postAuthor">{option.label}</ThemedText>
              {option.description ? (
                <ThemedText type="meta" themeColor="muted">
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
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Tints.chipIdleBorder,
  },
  text: {
    flex: 1,
    gap: 2,
  },
});
