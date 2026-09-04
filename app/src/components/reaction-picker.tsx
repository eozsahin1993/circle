import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Radius, Tints } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isSingleEmoji } from '@/services/emoji';

export type ReactionPickerProps = {
  onSelect: (emoji: string) => void;
};

/** A handful of one-tap reactions, plus a free-typed slot for anything else via the device's own emoji keyboard. */
const QUICK_REACTIONS = ['❤️', '😂', '😮', '🙏', '👏'];

export function ReactionPicker({ onSelect }: ReactionPickerProps) {
  const theme = useTheme();
  const [custom, setCustom] = useState('');

  function submitCustom() {
    if (isSingleEmoji(custom)) {
      onSelect(custom.trim());
      setCustom('');
    }
  }

  return (
    <View style={styles.row}>
      {QUICK_REACTIONS.map((emoji) => (
        <Pressable key={emoji} style={styles.quick} onPress={() => onSelect(emoji)}>
          <Text style={styles.quickEmoji}>{emoji}</Text>
        </Pressable>
      ))}

      <TextInput
        value={custom}
        onChangeText={setCustom}
        onSubmitEditing={submitCustom}
        onBlur={submitCustom}
        placeholder="🙂"
        placeholderTextColor={theme.faint}
        maxLength={8}
        style={[styles.customInput, { color: theme.text }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  quick: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Tints.chipIdleBg,
    borderWidth: 1,
    borderColor: Tints.chipIdleBorder,
  },
  quickEmoji: {
    fontSize: 18,
  },
  customInput: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    textAlign: 'center',
    fontSize: 18,
    backgroundColor: Tints.chipIdleBg,
    borderWidth: 1,
    borderColor: Tints.chipIdleBorder,
  },
});
